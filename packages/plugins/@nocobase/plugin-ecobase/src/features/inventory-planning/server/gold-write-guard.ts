/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';
import { EcobaseGoldError } from './gold-errors';

const goldWriteAuthority = Object.freeze({ owner: 'gold-refresh-run-service' });
const goldWriteContext = new AsyncLocalStorage<typeof goldWriteAuthority>();

interface GoldResourceContext {
  action?: { params?: { resourceName?: string } };
}

interface GoldWriteGuardDatabase {
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export function withGoldInventoryPlanningWriteAuthority<T>(write: () => Promise<T>) {
  return goldWriteContext.run(goldWriteAuthority, write);
}

function immutableArtifactError(operation: string) {
  return new EcobaseGoldError(
    'ECOBASE_GOLD_IMMUTABLE_ARTIFACT',
    `EcoBase Gold listing rows are immutable artifacts; ${operation} must create a new refresh-run cohort.`,
    { operation },
  );
}

export async function blockRawGoldInventoryPlanningAccess(ctx: GoldResourceContext, next: () => Promise<unknown>) {
  if (ctx.action?.params?.resourceName === ECOBASE_COLLECTIONS.goldInventoryPlanningRows) {
    throw Object.assign(
      new EcobaseGoldError(
        'ECOBASE_GOLD_RAW_ACCESS_FORBIDDEN',
        'EcoBase raw inventory-planning Gold access is forbidden; use the typed published-run resource.',
        { resourceName: ECOBASE_COLLECTIONS.goldInventoryPlanningRows },
      ),
      { status: 403 },
    );
  }
  await next();
}

export function registerGoldInventoryPlanningWriteGuard(db: GoldWriteGuardDatabase) {
  for (const event of ['beforeCreate', 'beforeBulkCreate']) {
    db.on(`${ECOBASE_COLLECTIONS.goldInventoryPlanningRows}.${event}`, () => {
      if (goldWriteContext.getStore() !== goldWriteAuthority) {
        throw immutableArtifactError('create');
      }
    });
  }
  for (const event of ['beforeUpdate', 'beforeBulkUpdate', 'beforeDestroy', 'beforeBulkDestroy']) {
    db.on(`${ECOBASE_COLLECTIONS.goldInventoryPlanningRows}.${event}`, () => {
      throw immutableArtifactError(event.toLowerCase());
    });
  }
}
