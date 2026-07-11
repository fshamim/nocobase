/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https:
 */

export type CanonicalCompanyIdentity = {
  companyKey: string;
  name: string;
};

const COMPANY_NAMES = [
  'Al Rehmat LLC',
  'Capitalx INC',
  'DTrading LLC',
  'Ecofission LLC',
  'Gigi USA INC',
  'GS Cart LTD',
  'Huka LLC',
  'KK and Sons Ltd',
  'Krosoft Ltd',
  'Mr Vendor Ltd',
  'Muxmco LLC',
  'Muxtex INC',
  'One4 LLC',
  'Retail Heaven Inc',
  'Sarosh and Sons Ltd',
  'Stop Shop LLC',
  'The Kraft Hub Ltd',
  'The Value Cart Ltd',
  'The Wellness Cart Ltd',
] as const;

function lookupKey(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, '');
}

function companyKey(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const COMPANY_BY_LOOKUP_KEY = new Map<string, CanonicalCompanyIdentity>(
  COMPANY_NAMES.map((name) => [lookupKey(name), { companyKey: companyKey(name), name }]),
);

export function resolveCanonicalCompany(value: string | undefined): CanonicalCompanyIdentity | null {
  const text = value?.trim();
  return text ? COMPANY_BY_LOOKUP_KEY.get(lookupKey(text)) ?? null : null;
}

export function requireCanonicalCompany(value: string): CanonicalCompanyIdentity {
  const company = resolveCanonicalCompany(value);
  if (!company) {
    throw new Error(
      `Ecobase company identity failed: unrecognized company "${value.trim()}". Add an approved canonical company before importing it.`,
    );
  }
  return company;
}
