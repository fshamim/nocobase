/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import { normalizeExternalOrderId } from './supplier-order-import-plan';

export interface ExportedSupplierOrderComment {
  companyId: string;
  orderId: string;
  orderRef: string;
  comment: Record<string, unknown> & {
    id: string;
    entityId: string;
    entityType: string;
    actorUserId?: number | string | null;
    sourceCommentKey?: string | null;
    deletedAt?: string | null;
  };
}

export interface SupplierOrderCommentTarget {
  id: string;
  companyId: string;
  orderRef: string;
}

export interface SupplierOrderCommentRelinkBlocker {
  commentId?: string;
  companyId?: string;
  orderRef?: string;
  reason:
    | 'target_order_identity_duplicate'
    | 'export_order_ref_invalid'
    | 'comment_identity_duplicate'
    | 'comment_source_key_duplicate'
    | 'comment_entity_mismatch'
    | 'comment_actor_missing'
    | 'comment_deleted'
    | 'target_order_missing';
}

export interface SupplierOrderCommentRelinkPlan {
  version: 'supplier-order-comment-relink-v1';
  digest: string;
  ready: boolean;
  inputCount: number;
  relinkedCount: number;
  blockers: SupplierOrderCommentRelinkBlocker[];
  comments: Array<Record<string, unknown>>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function prepareSupplierOrderCommentRelink(
  exported: ExportedSupplierOrderComment[],
  targetOrders: SupplierOrderCommentTarget[],
): SupplierOrderCommentRelinkPlan {
  const blockers: SupplierOrderCommentRelinkBlocker[] = [];
  const targets = new Map<string, SupplierOrderCommentTarget>();
  for (const order of targetOrders) {
    const orderRef = normalizeExternalOrderId(order.orderRef);
    if (!orderRef) continue;
    const identity = `${order.companyId}:${orderRef}`;
    if (targets.has(identity)) {
      blockers.push({ companyId: order.companyId, orderRef, reason: 'target_order_identity_duplicate' });
    } else {
      targets.set(identity, order);
    }
  }

  const commentIds = new Set<string>();
  const sourceKeys = new Set<string>();
  const comments: Array<Record<string, unknown>> = [];
  for (const row of exported) {
    const orderRef = normalizeExternalOrderId(row.orderRef);
    const commentId = String(row.comment.id ?? '');
    const sourceKey = String(row.comment.sourceCommentKey ?? '');
    let blocked = false;
    const block = (reason: SupplierOrderCommentRelinkBlocker['reason']) => {
      blockers.push({ commentId, companyId: row.companyId, orderRef: orderRef ?? row.orderRef, reason });
      blocked = true;
    };
    if (!orderRef) block('export_order_ref_invalid');
    if (commentIds.has(commentId)) block('comment_identity_duplicate');
    if (sourceKey && sourceKeys.has(sourceKey)) block('comment_source_key_duplicate');
    if (row.comment.entityType !== 'supplier_order' || row.comment.entityId !== row.orderId) {
      block('comment_entity_mismatch');
    }
    if (row.comment.actorUserId === null || row.comment.actorUserId === undefined) block('comment_actor_missing');
    if (row.comment.deletedAt) block('comment_deleted');
    const target = orderRef ? targets.get(`${row.companyId}:${orderRef}`) : undefined;
    if (!target) block('target_order_missing');
    commentIds.add(commentId);
    if (sourceKey) sourceKeys.add(sourceKey);
    if (!blocked && target) comments.push({ ...row.comment, entityId: target.id, entityType: 'supplier_order' });
  }

  const payload = {
    version: 'supplier-order-comment-relink-v1' as const,
    inputCount: exported.length,
    relinkedCount: comments.length,
    blockers: blockers.sort(
      (left, right) =>
        (left.companyId ?? '').localeCompare(right.companyId ?? '') ||
        (left.orderRef ?? '').localeCompare(right.orderRef ?? '') ||
        (left.commentId ?? '').localeCompare(right.commentId ?? '') ||
        left.reason.localeCompare(right.reason),
    ),
    comments,
  };
  return { ...payload, ready: blockers.length === 0 && comments.length === exported.length, digest: digest(payload) };
}
