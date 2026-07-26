/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * 066-D2: the "Data issues" workbench columns.
 *
 * The pane stopped being a read-only readiness list: every row is a product
 * whose issues can be diagnosed and (from T3 on) resolved in place. The five
 * columns are the diagnosis kit — who it is, what stock sits in each bucket,
 * what the engine believes about velocity, whether anyone has commented on the
 * problem already, and the issue cluster itself.
 *
 * Shared widgets are referenced, never re-implemented: `family`, `stock` and
 * `velocity` are the very same cells the product table renders, so the panes
 * cannot drift apart. Justified exclusions (D2): orderBy / orderQty /
 * moneyAtRisk / action are planning OUTPUTS and meaningless for rows the ladder
 * blocked before planning; supplier detail stays one row-click away.
 *
 * T1 ships the cluster INERT (tags only). T3 turns the resolvable codes into
 * real buttons with their resolution modals — the column keys and order do not
 * move again.
 */

import { Tag } from 'antd';
import React from 'react';
import type { DashboardRow } from '../server/contract';
import { reasonLabel, TEXT } from './dashboard-text';
import { DASHBOARD_TAG_COLORS } from './dashboard-tokens';
import type { Translate } from './format';
import type { PaneColumnConfig } from './pane-configs';
import { LAST_ACTIVITY_COLUMN } from './product-table-columns';
import { FamilyCell } from './widgets/FamilyCell';
import { StockBuckets } from './widgets/StockBuckets';
import { VelocityCover } from './widgets/VelocityCover';

/**
 * 066-D3 (T1 shape): one tag per reason code — NO cap, the cluster is the point
 * of this pane — followed by the inert `familySplit` corroboration tag.
 *
 * Deliberately absent: the tier tag. `FamilyCell` already wears the 065
 * recent-tier badge under the ONE badge rule, and repeating it here was v1
 * noise. Unknown codes fall through `reasonLabel` to their raw code so a
 * revived gold vocabulary degrades gracefully instead of crashing.
 */
function issuesCell(row: DashboardRow, t: Translate): React.ReactNode {
  const codes = Array.isArray(row.reasonCodes) ? row.reasonCodes : [];
  const tags: React.ReactNode[] = codes.map((code) => (
    <Tag key={`issue-${code}`} color={DASHBOARD_TAG_COLORS.warning}>
      {reasonLabel(code, t)}
    </Tag>
  ));
  if (row.familySplit) {
    tags.push(
      <Tag key="split" color={DASHBOARD_TAG_COLORS.neutral}>
        {t(TEXT.badgeFamilySplit)}
      </Tag>,
    );
  }
  return <span>{tags}</span>;
}

export const DATA_ISSUES_COLUMNS: PaneColumnConfig[] = [
  { key: 'family', titleKey: TEXT.colProduct, render: (row, t, ctx) => <FamilyCell row={row} t={t} ctx={ctx} /> },
  { key: 'stock', titleKey: TEXT.colStock, render: (row, t) => <StockBuckets stock={row.stock} t={t} /> },
  { key: 'velocity', titleKey: TEXT.colVelocityCover, render: (row, t) => <VelocityCover row={row} t={t} /> },
  LAST_ACTIVITY_COLUMN,
  { key: 'issues', titleKey: TEXT.colIssues, render: (row, t) => issuesCell(row, t) },
];
