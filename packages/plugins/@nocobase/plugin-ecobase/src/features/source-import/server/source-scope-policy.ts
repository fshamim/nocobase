/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import {
  FOUR_COMPANY_MIGRATION_PROFILE,
  type FourCompanyKey,
  type MigrationCompanySource,
} from './four-company-migration-profile';

export type MigrationDecision =
  | { disposition: 'accept'; companyKey: FourCompanyKey; reasonCode: string }
  | { disposition: 'discard'; reasonCode: string }
  | { disposition: 'review'; companyKey: FourCompanyKey; reasonCode: string };

export interface CompanyScopeInput {
  source: MigrationCompanySource;
  explicitCompany?: string;
  orderRef?: string;
  acceptedHeaderCompany?: string;
}

function comparisonKey(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-US');
}

const CANONICAL_COMPANY_BY_NAME = new Map(
  FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.map((company) => [comparisonKey(company.name), company]),
);

export function resolveMigrationCompany(value: string | undefined, source: MigrationCompanySource) {
  const text = value?.trim();
  if (!text) return undefined;
  const canonical = CANONICAL_COMPANY_BY_NAME.get(comparisonKey(text));
  if (canonical) return { ...canonical, match: 'canonical' as const };
  const alias = FOUR_COMPANY_MIGRATION_PROFILE.companyAliasesBySource[source].find(
    (candidate) => comparisonKey(candidate.alias) === comparisonKey(text),
  );
  if (!alias) return undefined;
  const company = FOUR_COMPANY_MIGRATION_PROFILE.canonicalCompanies.find(
    (candidate) => candidate.companyKey === alias.companyKey,
  );
  return company ? { ...company, match: 'source_alias' as const } : undefined;
}

export function migrationCompanyKeyForOrderRef(orderRef: string | undefined) {
  const normalized = orderRef?.normalize('NFKC').trim().toUpperCase();
  if (!normalized) return undefined;
  return FOUR_COMPANY_MIGRATION_PROFILE.orderPrefixCompanyKeys[
    normalized.slice(0, 2) as keyof typeof FOUR_COMPANY_MIGRATION_PROFILE.orderPrefixCompanyKeys
  ];
}

export function decideCompanyScope(input: CompanyScopeInput): MigrationDecision {
  const explicitText = input.explicitCompany?.trim();
  const headerText = input.acceptedHeaderCompany?.trim();
  const explicit = resolveMigrationCompany(explicitText, input.source);
  const header = resolveMigrationCompany(headerText, input.source);
  const prefixCompanyKey = migrationCompanyKeyForOrderRef(input.orderRef);

  if (explicitText && !explicit) return { disposition: 'discard', reasonCode: 'company_out_of_scope' };
  if (headerText && !header) return { disposition: 'discard', reasonCode: 'header_company_out_of_scope' };
  if (input.orderRef && !prefixCompanyKey) return { disposition: 'discard', reasonCode: 'unsupported_order_ref' };

  const companyKeys = [explicit?.companyKey, header?.companyKey, prefixCompanyKey].filter(
    (value): value is FourCompanyKey => Boolean(value),
  );
  if (!companyKeys.length) return { disposition: 'discard', reasonCode: 'company_missing' };
  if (new Set(companyKeys).size !== 1) return { disposition: 'discard', reasonCode: 'company_evidence_conflict' };

  const companyKey = companyKeys[0];
  if (!explicit && input.orderRef) {
    return header
      ? { disposition: 'review', companyKey, reasonCode: 'company_from_header_and_order_prefix' }
      : { disposition: 'discard', reasonCode: 'company_evidence_incomplete' };
  }
  return {
    disposition: 'accept',
    companyKey,
    reasonCode: explicit?.match === 'source_alias' ? 'approved_source_alias' : 'canonical_company',
  };
}
