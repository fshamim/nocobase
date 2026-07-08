/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'node:crypto';
import { Migration } from '@nocobase/server';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import {
  normalizeExternalSupplierCode,
  normalizeSupplierName,
} from '../../features/semantic-model/server/medallion-identity-service';
import { toPlainRecord } from '../../features/source-import/server/import-service';

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const linkRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverNormalizationLinks);
    const bronzeRepo = this.db.getRepository(ECOBASE_COLLECTIONS.bronzeSourceRecords);
    const refRepo = this.db.getRepository(ECOBASE_COLLECTIONS.silverSupplierExternalRefs);
    const links = await linkRepo.find({
      filter: { silverEntityType: 'silverSupplier' },
      limit: 100000,
    });

    for (const linkRecord of links) {
      const link = toPlainRecord(linkRecord);
      const supplierId = textValue(link.silverEntityId);
      const bronzeRecordId = textValue(link.bronzeRecordId);
      if (!supplierId || !bronzeRecordId) continue;

      const bronze = toPlainRecord(await bronzeRepo.findOne({ filterByTk: bronzeRecordId }));
      const payload = toPlainRecord(bronze.payload);
      const externalSupplierCode = textValue(payload['SR ID']) ?? textValue(payload['SR ID ']);
      const normalizedExternalSupplierCode = normalizeExternalSupplierCode(externalSupplierCode);
      if (!normalizedExternalSupplierCode) continue;

      const existing = await refRepo.findOne({
        filter: { sourceSystem: 'supplier_ids', normalizedExternalSupplierCode },
      });
      if (existing) continue;

      const displayName =
        textValue(payload.Supplier) ??
        textValue(payload['Supplier ']) ??
        textValue(payload['Supplier Name']) ??
        normalizedExternalSupplierCode;
      await refRepo.create({
        values: {
          id: randomUUID(),
          supplierId,
          sourceSystem: 'supplier_ids',
          externalSupplierCode,
          normalizedExternalSupplierCode,
          displayName,
          normalizedName: normalizeSupplierName(displayName),
          sourceConnectionId: textValue(bronze.sourceConnectionId),
          lastSeenAt: textValue(bronze.observedAt) ?? textValue(bronze.normalizedAt),
          payload,
        },
      });
    }
  }
}

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
