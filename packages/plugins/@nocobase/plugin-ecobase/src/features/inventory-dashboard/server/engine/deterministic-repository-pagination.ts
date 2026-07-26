/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

const DEFAULT_PAGE_SIZE = 500;

type FindParams = {
  filter?: Record<string, unknown>;
  sort?: string[];
  limit?: number;
  offset?: number;
  transaction?: unknown;
};

type Repository = {
  find(params: FindParams): Promise<unknown[]>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const model = value as { toJSON?: () => unknown };
  const plain = typeof model.toJSON === 'function' ? model.toJSON() : value;
  return plain && typeof plain === 'object' && !Array.isArray(plain) ? (plain as Record<string, unknown>) : {};
}

export async function readAllRowsById(params: {
  repository: Repository;
  collectionName: string;
  filter?: Record<string, unknown>;
  transaction?: unknown;
  pageSize?: number;
}) {
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`EcoBase deterministic pagination for "${params.collectionName}" requires a positive page size.`);
  }
  const rows: unknown[] = [];
  const ids = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = await params.repository.find({
      ...(params.filter ? { filter: params.filter } : {}),
      sort: ['id'],
      limit: pageSize,
      offset,
      transaction: params.transaction,
    });
    if (page.length > pageSize) {
      throw new Error(
        `EcoBase deterministic pagination for "${params.collectionName}" returned ${page.length} rows for page size ${pageSize}.`,
      );
    }
    for (const row of page) {
      const id = record(row).id;
      if ((typeof id !== 'string' && typeof id !== 'number') || String(id).length === 0) {
        throw new Error(`EcoBase deterministic pagination for "${params.collectionName}" found a row without id.`);
      }
      const normalizedId = `${typeof id}:${String(id)}`;
      if (ids.has(normalizedId)) {
        throw new Error(
          `EcoBase deterministic pagination for "${params.collectionName}" returned duplicate id "${String(id)}".`,
        );
      }
      ids.add(normalizedId);
      rows.push(row);
    }
    if (page.length < pageSize) return rows;
    offset += page.length;
  }
}
