/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  prepareSupplierOrderCommentRelink,
  type ExportedSupplierOrderComment,
} from '../../features/source-import/server/supplier-order-import/supplier-order-comment-relink';

function exported(): ExportedSupplierOrderComment[] {
  return [
    {
      companyId: 'company-1',
      orderId: 'old-order-1',
      orderRef: ' ef 71626a ',
      comment: {
        id: 'comment-1',
        entityId: 'old-order-1',
        entityType: 'supplier_order',
        actorUserId: 7,
        sourceCommentKey: 'source-comment-1',
        deletedAt: null,
        body: 'Preserve exactly',
      },
    },
  ];
}

describe('supplier/order comment relink', () => {
  it('relinks comments by preserved company and canonical order reference', () => {
    const result = prepareSupplierOrderCommentRelink(exported(), [
      { id: 'new-order-1', companyId: 'company-1', orderRef: 'EF71626A' },
    ]);

    expect(result.ready).toBe(true);
    expect(result).toMatchObject({ inputCount: 1, relinkedCount: 1, blockers: [] });
    expect(result.comments).toEqual([
      expect.objectContaining({
        id: 'comment-1',
        entityId: 'new-order-1',
        entityType: 'supplier_order',
        actorUserId: 7,
        body: 'Preserve exactly',
      }),
    ]);
  });

  it('blocks every comment whose canonical target is absent', () => {
    const result = prepareSupplierOrderCommentRelink(exported(), []);

    expect(result.ready).toBe(false);
    expect(result.comments).toEqual([]);
    expect(result.blockers).toEqual([
      expect.objectContaining({ commentId: 'comment-1', orderRef: 'EF71626A', reason: 'target_order_missing' }),
    ]);
  });
});
