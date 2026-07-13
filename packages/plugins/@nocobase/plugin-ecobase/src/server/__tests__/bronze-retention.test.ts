/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  bronzeRetentionUntil,
  EcobaseBronzeImportService,
} from '../../features/source-import/server/bronze-import-service';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';

describe('Bronze field retention', () => {
  it('expires projected evidence exactly 30 UTC days after observation', () => {
    expect(bronzeRetentionUntil('2026-07-13T00:00:00.000Z')).toBe('2026-08-12T00:00:00.000Z');
    expect(bronzeRetentionUntil('2026-02-10T12:30:00.000Z')).toBe('2026-03-12T12:30:00.000Z');
  });

  it('deletes only records older than the explicit cleanup instant', async () => {
    const destroy = vi.fn(async () => 2);
    const repository = {
      find: vi.fn(),
      findOne: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      destroy,
    } as unknown as EcobaseRepository;
    const db = { getRepository: vi.fn(() => repository) } as unknown as EcobaseDatabase;

    await expect(
      new EcobaseBronzeImportService(db).deleteExpiredSourceRecords('2026-08-13T00:00:00.000Z'),
    ).resolves.toBe(2);
    expect(destroy).toHaveBeenCalledWith({
      filter: { retentionUntil: { $lt: '2026-08-13T00:00:00.000Z' } },
    });
  });
});
