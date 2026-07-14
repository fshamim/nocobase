/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'node:crypto';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import type { EcobaseDatabase, EcobaseRepository } from '../../source-import/server/import-service';
import { toPlainRecord } from '../../source-import/server/import-service';

export type ProductLifecycleStatus = 'draft' | 'active' | 'archived';
export type SupplierProductRole = 'preferred' | 'candidate' | 'latest_used';

export interface UpsertCompanyParams {
  companyKey: string;
  name: string;
}

export interface UpsertProductParams {
  asin: string;
  sku: string;
  title?: string;
  brand?: string;
  lifecycleStatus?: ProductLifecycleStatus;
  mappingStatus?: string;
}

export interface UpdateDraftProductIdentityParams {
  productId: string;
  asin: string;
  sku: string;
}

export interface EnsureDefaultAmazonAccountParams {
  companyId: string;
  marketplace?: string;
  name?: string;
}

export interface UpsertCompanyProductParams {
  companyId: string;
  amazonAccountId: string;
  productId: string;
  lifecycleStatus?: string;
  listingStatus?: string;
}

export interface UpsertSupplierParams {
  displayName: string;
  approvalStatus?: string;
}

export interface UpsertSupplierExternalRefParams {
  sourceSystem: string;
  externalSupplierCode: string;
  displayName?: string;
  sourceConnectionId?: string;
  observedAt?: string;
  payload?: Record<string, unknown>;
  approvalStatus?: string;
  identityAuthority?: 'authoritative' | 'reference';
}

export interface UpsertSupplierProductParams {
  supplierId: string;
  productId: string;
  supplierSku?: string;
  unitCost?: number;
  moq?: number;
  supplierPackSize?: number;
  leadTimeDays?: number;
  leadTimeIsDefault?: boolean;
  prepCapability?: string;
  analysisStatus?: string;
}

export interface UpsertCompanyProductSupplierParams {
  companyProductId: string;
  supplierProductId: string;
  role: SupplierProductRole;
  lastUsedAt?: string;
}

function requiredText(value: string | undefined, fieldName: string) {
  const text = value?.trim();
  if (!text) {
    throw new Error(`Ecobase medallion identity failed: ${fieldName} is required.`);
  }
  return text;
}

export function normalizeCompanyKey(value: string) {
  const key = requiredText(value, 'companyKey').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(key)) {
    throw new Error(
      'Ecobase medallion identity failed: companyKey must be 2-32 chars of A-Z, 0-9, underscore, or dash.',
    );
  }
  return key;
}

export function normalizeSupplierName(value: string) {
  const normalized = requiredText(value, 'supplier displayName')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) {
    throw new Error('Ecobase medallion identity failed: supplier displayName must include letters or numbers.');
  }
  return normalized;
}

export function normalizeExternalSupplierCode(value: string | undefined) {
  const text = value?.trim();
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, ' ').toUpperCase();
  if (['DUPLICATE', 'DUP', 'N/A', 'NA', 'NONE', '-'].includes(normalized)) return undefined;
  return normalized;
}

function idOf(record: unknown) {
  const id = toPlainRecord(record).id;
  return typeof id === 'string' ? id : undefined;
}

function valuesForUpdate(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function latestTimestamp(existing: string | undefined, incoming: string | undefined) {
  if (!incoming) return existing;
  const incomingTime = new Date(incoming).getTime();
  if (!Number.isFinite(incomingTime)) {
    throw new Error(`Ecobase medallion identity failed: lastUsedAt "${incoming}" is invalid.`);
  }
  if (!existing) return incoming;
  const existingTime = new Date(existing).getTime();
  if (!Number.isFinite(existingTime)) {
    throw new Error(`Ecobase medallion identity failed: existing lastUsedAt "${existing}" is invalid.`);
  }
  return incomingTime > existingTime ? incoming : existing;
}

export class EcobaseMedallionIdentityService {
  constructor(private db: EcobaseDatabase) {}

  async upsertCompany(params: UpsertCompanyParams) {
    const companyKey = normalizeCompanyKey(params.companyKey);
    const name = requiredText(params.name, 'company name');
    const repo = this.repo(ECOBASE_COLLECTIONS.silverCompanies);
    const existing = await repo.findOne({ filter: { companyKey } });
    if (existing) {
      await repo.update({ filterByTk: idOf(existing), values: { name } });
      return this.findRequired(repo, idOf(existing), 'company');
    }
    return repo.create({ values: { id: randomUUID(), companyKey, name } });
  }

  async upsertProduct(params: UpsertProductParams) {
    const asin = requiredText(params.asin, 'asin');
    const sku = requiredText(params.sku, 'sku');
    const repo = this.repo(ECOBASE_COLLECTIONS.silverProducts);
    const existing = await repo.findOne({ filter: { asin, sku } });
    const values = valuesForUpdate({ title: params.title, brand: params.brand, mappingStatus: params.mappingStatus });
    if (existing) {
      if (Object.keys(values).length > 0) {
        await repo.update({ filterByTk: idOf(existing), values });
        return this.findRequired(repo, idOf(existing), 'product');
      }
      return existing;
    }
    return repo.create({
      values: {
        id: randomUUID(),
        asin,
        sku,
        title: params.title,
        brand: params.brand,
        lifecycleStatus: params.lifecycleStatus ?? 'draft',
        mappingStatus: params.mappingStatus ?? 'draft',
      },
    });
  }

  async updateDraftProductIdentity(params: UpdateDraftProductIdentityParams) {
    const asin = requiredText(params.asin, 'asin');
    const sku = requiredText(params.sku, 'sku');
    const repo = this.repo(ECOBASE_COLLECTIONS.silverProducts);
    const product = await this.findRequired(repo, params.productId, 'product');
    if (toPlainRecord(product).lifecycleStatus !== 'draft') {
      throw new Error(
        'Ecobase medallion identity failed: product ASIN/SKU can only be edited while lifecycleStatus is draft.',
      );
    }
    const duplicate = await repo.findOne({ filter: { asin, sku } });
    if (duplicate && idOf(duplicate) !== params.productId) {
      throw new Error(`Ecobase medallion identity failed: product ${asin}/${sku} already exists.`);
    }
    await repo.update({ filterByTk: params.productId, values: { asin, sku } });
    return this.findRequired(repo, params.productId, 'product');
  }

  async ensureDefaultAmazonAccount(params: EnsureDefaultAmazonAccountParams) {
    await this.requireRecord(ECOBASE_COLLECTIONS.silverCompanies, params.companyId, 'company');
    const marketplace = requiredText(params.marketplace ?? 'default', 'marketplace');
    const repo = this.repo(ECOBASE_COLLECTIONS.silverAmazonAccounts);
    const existing = await repo.findOne({ filter: { companyId: params.companyId, marketplace, isDefault: true } });
    if (existing) return existing;
    return repo.create({
      values: {
        id: randomUUID(),
        companyId: params.companyId,
        marketplace,
        name: params.name ?? `Default ${marketplace}`,
        isDefault: true,
        status: 'active',
      },
    });
  }

  async upsertCompanyProduct(params: UpsertCompanyProductParams) {
    await this.requireRecord(ECOBASE_COLLECTIONS.silverCompanies, params.companyId, 'company');
    await this.requireRecord(ECOBASE_COLLECTIONS.silverAmazonAccounts, params.amazonAccountId, 'amazon account');
    await this.requireRecord(ECOBASE_COLLECTIONS.silverProducts, params.productId, 'product');
    return this.upsertByFilter(ECOBASE_COLLECTIONS.silverCompanyProducts, {
      filter: {
        companyId: params.companyId,
        amazonAccountId: params.amazonAccountId,
        productId: params.productId,
      },
      values: {
        companyId: params.companyId,
        amazonAccountId: params.amazonAccountId,
        productId: params.productId,
        lifecycleStatus: params.lifecycleStatus ?? 'candidate_new_product',
        listingStatus: params.listingStatus ?? 'not_listed',
      },
    });
  }

  async upsertSupplier(params: UpsertSupplierParams) {
    const displayName = requiredText(params.displayName, 'supplier displayName');
    const normalizedName = normalizeSupplierName(displayName);
    return this.upsertByFilter(ECOBASE_COLLECTIONS.silverSuppliers, {
      filter: { normalizedName },
      values: { normalizedName, displayName, approvalStatus: params.approvalStatus ?? 'analyzing' },
    });
  }

  async upsertSupplierExternalRef(params: UpsertSupplierExternalRefParams) {
    const sourceSystem = requiredText(params.sourceSystem, 'supplier sourceSystem');
    const normalizedExternalSupplierCode = normalizeExternalSupplierCode(params.externalSupplierCode);
    if (!normalizedExternalSupplierCode) {
      throw new Error('Ecobase medallion identity failed: externalSupplierCode is required.');
    }

    const refRepo = this.repo(ECOBASE_COLLECTIONS.silverSupplierExternalRefs);
    const existingRef = await refRepo.findOne({ filter: { sourceSystem, normalizedExternalSupplierCode } });
    const authoritative = params.identityAuthority !== 'reference';
    if (!existingRef && !authoritative) {
      throw new Error(
        `Ecobase medallion identity failed: supplier ${normalizedExternalSupplierCode} was not established by Supplier Management.`,
      );
    }
    const displayName = params.displayName?.trim() || normalizedExternalSupplierCode;
    const normalizedName = normalizeSupplierName(displayName);
    const refValues = valuesForUpdate({
      sourceSystem,
      externalSupplierCode: params.externalSupplierCode.trim(),
      normalizedExternalSupplierCode,
      displayName: !existingRef || authoritative ? displayName : undefined,
      normalizedName: !existingRef || authoritative ? normalizedName : undefined,
      sourceConnectionId: params.sourceConnectionId,
      lastSeenAt: params.observedAt,
      payload: params.payload,
    });

    if (existingRef) {
      const supplierId = toPlainRecord(existingRef).supplierId;
      if (typeof supplierId !== 'string') {
        throw new Error('Ecobase medallion identity failed: supplier external ref is missing supplierId.');
      }
      const supplier = await this.findRequired(this.repo(ECOBASE_COLLECTIONS.silverSuppliers), supplierId, 'supplier');
      await this.repo(ECOBASE_COLLECTIONS.silverSuppliers).update({
        filterByTk: supplierId,
        values: valuesForUpdate({
          displayName: authoritative ? displayName : undefined,
          normalizedName: authoritative ? normalizedName : undefined,
          approvalStatus: authoritative ? params.approvalStatus : undefined,
        }),
      });
      await refRepo.update({ filterByTk: idOf(existingRef), values: refValues });
      return this.findRequired(this.repo(ECOBASE_COLLECTIONS.silverSuppliers), idOf(supplier), 'supplier');
    }

    const supplier = await this.repo(ECOBASE_COLLECTIONS.silverSuppliers).create({
      values: {
        id: randomUUID(),
        normalizedName,
        displayName,
        approvalStatus: params.approvalStatus ?? 'analyzing',
      },
    });
    await refRepo.create({
      values: {
        id: randomUUID(),
        supplierId: idOf(supplier),
        ...refValues,
      },
    });
    return supplier;
  }

  async upsertSupplierProduct(params: UpsertSupplierProductParams) {
    await this.requireRecord(ECOBASE_COLLECTIONS.silverSuppliers, params.supplierId, 'supplier');
    await this.requireRecord(ECOBASE_COLLECTIONS.silverProducts, params.productId, 'product');
    const { leadTimeIsDefault, ...values } = params;
    const repo = this.repo(ECOBASE_COLLECTIONS.silverSupplierProducts);
    const filter = { supplierId: params.supplierId, productId: params.productId };
    const existing = await repo.findOne({ filter });
    const existingLeadTimeDays = toPlainRecord(existing).leadTimeDays;
    if (existing && leadTimeIsDefault && typeof existingLeadTimeDays === 'number') {
      delete values.leadTimeDays;
    }
    if (existing) {
      await repo.update({ filterByTk: idOf(existing), values: valuesForUpdate(values) });
      return this.findRequired(repo, idOf(existing), ECOBASE_COLLECTIONS.silverSupplierProducts);
    }
    return repo.create({ values: { id: randomUUID(), ...valuesForUpdate(values) } });
  }

  async upsertCompanyProductSupplier(params: UpsertCompanyProductSupplierParams, transaction?: unknown) {
    await this.requireRecord(
      ECOBASE_COLLECTIONS.silverCompanyProducts,
      params.companyProductId,
      'company product',
      transaction,
    );
    await this.requireRecord(
      ECOBASE_COLLECTIONS.silverSupplierProducts,
      params.supplierProductId,
      'supplier product',
      transaction,
    );
    const repo = this.repo(ECOBASE_COLLECTIONS.silverCompanyProductSuppliers);
    const filter = {
      companyProductId: params.companyProductId,
      supplierProductId: params.supplierProductId,
      role: params.role,
    };
    const existing = await repo.findOne({ filter, transaction } as never);
    const existingLastUsedAt = toPlainRecord(existing).lastUsedAt;
    const lastUsedAt = latestTimestamp(
      typeof existingLastUsedAt === 'string' ? existingLastUsedAt : undefined,
      params.lastUsedAt,
    );
    if (existing) {
      await repo.update({
        filterByTk: idOf(existing),
        values: valuesForUpdate({ ...params, lastUsedAt }),
        transaction,
      } as never);
      return this.findRequired(repo, idOf(existing), ECOBASE_COLLECTIONS.silverCompanyProductSuppliers, transaction);
    }
    return repo.create({
      values: { id: randomUUID(), ...valuesForUpdate({ ...params, lastUsedAt }) },
      transaction,
    } as never);
  }

  private async upsertByFilter(
    collectionName: string,
    params: { filter: Record<string, unknown>; values: Record<string, unknown> },
  ) {
    const repo = this.repo(collectionName);
    const existing = await repo.findOne({ filter: params.filter });
    if (existing) {
      await repo.update({ filterByTk: idOf(existing), values: valuesForUpdate(params.values) });
      return this.findRequired(repo, idOf(existing), collectionName);
    }
    return repo.create({ values: { id: randomUUID(), ...valuesForUpdate(params.values) } });
  }

  private async findRequired(repo: EcobaseRepository, id: string | undefined, label: string, transaction?: unknown) {
    const record = await this.findById(repo, id, label, transaction);
    if (!record) {
      throw new Error(`Ecobase medallion identity failed: ${label} ${id} was not found after update.`);
    }
    return record;
  }

  private async requireRecord(collectionName: string, id: string | undefined, label: string, transaction?: unknown) {
    const record = await this.findById(this.repo(collectionName), id, label, transaction);
    if (!record) {
      throw new Error(`Ecobase medallion identity failed: ${label} ${id} does not exist.`);
    }
    return record;
  }

  private async findById(repo: EcobaseRepository, id: string | undefined, label: string, transaction?: unknown) {
    if (!id) {
      throw new Error(`Ecobase medallion identity failed: ${label} id is missing.`);
    }
    return repo.findOne({ filterByTk: id, transaction } as never);
  }

  private repo(name: string) {
    return this.db.getRepository(name);
  }
}
