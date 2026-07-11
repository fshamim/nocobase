/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https:
 */

import { describe, expect, it } from 'vitest';
import { selectSupplierProductLink } from '../../features/supplier-management/server/supplier-order-service';

describe('supplier product link selection', () => {
  it('selects the most recently used candidate independently of input order', () => {
    const older = { supplierId: 'older', role: 'candidate', active: true, lastUsedAt: '2026-01-01T00:00:00.000Z' };
    const newer = { supplierId: 'newer', role: 'candidate', active: true, lastUsedAt: '2026-02-01T00:00:00.000Z' };

    expect(selectSupplierProductLink([older, newer])).toBe(newer);
    expect(selectSupplierProductLink([newer, older])).toBe(newer);
  });

  it('keeps an active preferred supplier above usage recency', () => {
    const preferred = { supplierId: 'preferred', role: 'preferred', active: true };
    const recent = { supplierId: 'recent', role: 'candidate', active: true, lastUsedAt: '2026-02-01T00:00:00.000Z' };
    const inactivePreferred = { supplierId: 'inactive', role: 'preferred', active: false };

    expect(selectSupplierProductLink([recent, preferred])).toBe(preferred);
    expect(selectSupplierProductLink([inactivePreferred, recent])).toBe(recent);
  });
});
