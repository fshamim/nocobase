/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import SupplierOrderSourceSchemaMigration from '../migrations/20260716050000-add-supplier-order-source-schema';
import FixReceivedEmailSourceTypeMigration from '../migrations/20260716051000-fix-received-email-source-type';
import CanonicalOrderLinkageMigration from '../migrations/20260716052000-add-canonical-order-linkage';
import OrderLineMappingScopeConstraintMigration from '../migrations/20260716154000-enforce-order-line-mapping-scope';

type FieldRecord = Record<string, unknown> & { collectionName: string; name: string };

describe('supplier/order source schema migration', () => {
  it('adds the source-complete fields idempotently', async () => {
    const fields: FieldRecord[] = [];
    const fieldRepo = {
      findOne: async ({ filter }: { filter: { collectionName: string; name: string } }) =>
        fields.find((field) => field.collectionName === filter.collectionName && field.name === filter.name),
      create: async ({ values }: { values: FieldRecord }) => fields.push(values),
    };
    const migration = new SupplierOrderSourceSchemaMigration({
      db: { getRepository: (name: string) => (name === 'fields' ? fieldRepo : undefined) },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();
    await migration.up();

    expect(fields).toHaveLength(60);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverSuppliers,
          name: 'additionalEmails',
          type: 'jsonb',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverSuppliers,
          name: 'sourceEvidence',
          type: 'jsonb',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverSuppliers,
          name: 'receivedEmail',
          type: 'text',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverSuppliers,
          name: 'amazonPresence',
          type: 'string',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverSupplierAccounts,
          name: 'loginSecretRef',
          type: 'string',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverSupplierAccounts,
          name: 'loginSecret',
          type: 'string',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverOrders,
          name: 'supplierExternalRef',
          type: 'belongsTo',
          foreignKey: 'supplierExternalRefId',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverOrders,
          name: 'workflowStage',
          type: 'string',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverOrderLines,
          name: 'lineOrdinal',
          type: 'integer',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverOrderLines,
          name: 'sourceEvidence',
          type: 'jsonb',
        }),
      ]),
    );
  });

  it('adds canonical order and family-linkage fields idempotently', async () => {
    const fields: FieldRecord[] = [];
    const fieldRepo = {
      findOne: async ({ filter }: { filter: { collectionName: string; name: string } }) =>
        fields.find((field) => field.collectionName === filter.collectionName && field.name === filter.name),
      create: async ({ values }: { values: FieldRecord }) => fields.push(values),
    };
    const migration = new CanonicalOrderLinkageMigration({
      db: { getRepository: (name: string) => (name === 'fields' ? fieldRepo : undefined) },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();
    await migration.up();

    expect(fields).toHaveLength(19);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverOrders,
          name: 'purchaseEvidenceStatus',
          type: 'string',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverOrderLines,
          name: 'companyProductFamily',
          type: 'belongsTo',
          foreignKey: 'companyProductFamilyId',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverOrders,
          name: 'historicalPurchaseOutcome',
          type: 'string',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverOrders,
          name: 'amazonAccount',
          type: 'belongsTo',
          foreignKey: 'amazonAccountId',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.silverOrderLines,
          name: 'mappingScope',
          type: 'string',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.planningSettings,
          name: 'defaultSupplierLeadTimeDays',
          defaultValue: 30,
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
          name: 'supplierOrderOperationalStatus',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
          name: 'supplierOrderWorkflowStage',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
          name: 'supplierOrderSourceMemberSku',
        }),
        expect.objectContaining({
          collectionName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows,
          name: 'supplierOrderLineMappingScope',
        }),
      ]),
    );
  });

  it('enforces exact-member, family-only, and unresolved linkage shapes for new writes', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ exists: false }]])
      .mockResolvedValueOnce(undefined);
    const migration = new OrderLineMappingScopeConstraintMigration({
      db: {
        getCollection: () => ({ getTableNameWithSchema: () => 'silverOrderLines' }),
        sequelize: {
          getQueryInterface: () => ({
            queryGenerator: {
              quoteTable: (value: string) => `"${value}"`,
              quoteIdentifier: (value: string) => `"${value}"`,
            },
          }),
          query,
        },
      },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();

    const sql = String(query.mock.calls[1][0]);
    expect(sql).toContain('"mappingScope" = \'exact_member\'');
    expect(sql).toContain('"companyProductFamilyId" IS NOT NULL');
    expect(sql).toContain('"mappingScope" = \'family_only\'');
    expect(sql).toContain('"companyProductId" IS NULL');
    expect(sql).toContain('"supplierProductId" IS NULL');
    expect(sql).toContain('"mappingScope" = \'unresolved\'');
    expect(sql).toContain('NOT VALID');
  });

  it('upgrades the received-email field from the incorrect boolean source type', async () => {
    const changeColumn = vi.fn();
    const update = vi.fn();
    const transaction = {};
    const migration = new FixReceivedEmailSourceTypeMigration({
      db: {
        getCollection: () => ({ getTableNameWithSchema: () => 'silverSuppliers' }),
        getRepository: () => ({ update }),
        sequelize: {
          getQueryInterface: () => ({
            describeTable: async () => ({ receivedEmail: { type: 'BOOLEAN' } }),
            changeColumn,
          }),
          transaction: async (callback: (transaction: unknown) => Promise<void>) => callback(transaction),
        },
      },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await migration.up();

    expect(changeColumn).toHaveBeenCalledWith(
      'silverSuppliers',
      'receivedEmail',
      expect.objectContaining({ type: expect.anything() }),
      { transaction },
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { collectionName: ECOBASE_COLLECTIONS.silverSuppliers, name: 'receivedEmail' },
        values: { type: 'text', interface: 'textarea' },
      }),
    );
  });

  it('fails explicitly when collection metadata is unavailable', async () => {
    const migration = new SupplierOrderSourceSchemaMigration({
      db: { getRepository: () => undefined },
      queryInterface: undefined,
      sequelize: undefined,
    } as never);

    await expect(migration.up()).rejects.toThrow(
      'Ecobase supplier/order source-schema migration failed: fields repository is unavailable.',
    );
  });
});
