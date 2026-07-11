/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { resolveCanonicalCompany } from '../../../server/company-identity';
import { normalizeExternalSupplierCode } from '../../semantic-model/server/medallion-identity-service';
import { CsvRowReader } from './adapters/csv-utils';

export function orderDetailSourceIdentity(row: CsvRowReader) {
  const company = resolveCanonicalCompany(row.string('Company'));
  return {
    company,
    orderRef: row.string('Order ID', 'externalOrderRef'),
    supplierCode: normalizeExternalSupplierCode(row.string('SR ID', 'SR ID ', 'externalSupplierCode')),
    asin: row.string('ASIN', 'ASIN ')?.toUpperCase(),
    sku: row.string('SKU') ?? row.string('UPC'),
    orderedQty: row.number('Qty', 'Ordered'),
    unitCost: row.number('PPU', 'COGS', 'Exp. Cost '),
  };
}
