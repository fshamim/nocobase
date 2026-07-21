/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Bird's-eye KPI strip (REQ-H1..H6, T-2.2). Each tile shows count + money
 * (with unknownCount for null inputs) and deep-links to its pane: clicking
 * triggers that pane's fetch if not yet loaded and moves focus to its heading.
 */

import { Button, Card, Space, Typography } from 'antd';
import React from 'react';
import type { DashboardHeader as DashboardHeaderData, HeaderTileKey, PaneKey } from '../server/contract';
import { TEXT } from './dashboard-text';
import { DASHBOARD_TOKENS } from './dashboard-tokens';
import { formatMoney, type Translate } from './format';

const TILE_TITLE: Record<HeaderTileKey, string> = {
  urgentStockout: TEXT.tileUrgentStockout,
  orderedButLate: TEXT.tileOrderedButLate,
  staleLeadTimes: TEXT.tileStaleLeadTimes,
  needsFollowUp: TEXT.tileNeedsFollowUp,
  stuckCapital: TEXT.tileStuckCapital,
};

export interface DashboardHeaderProps {
  header: DashboardHeaderData;
  onTileClick: (pane: PaneKey) => void;
  t: Translate;
}

const DashboardHeaderStrip: React.FC<DashboardHeaderProps> = ({ header, onTileClick, t }) => (
  <Space
    wrap
    size="middle"
    style={{ marginBottom: DASHBOARD_TOKENS.sectionGap }}
    role="group"
    aria-label={t(TEXT.pageTitle)}
  >
    {header.tiles.map((tile) => (
      <Card key={tile.key} size="small" style={{ minWidth: DASHBOARD_TOKENS.tileMinWidth }}>
        <Button
          type="text"
          onClick={() => onTileClick(tile.targetPane)}
          aria-label={t(TILE_TITLE[tile.key])}
          style={{ height: 'auto', padding: 0, textAlign: 'left', display: 'block', width: '100%' }}
        >
          <Typography.Text type="secondary" style={{ display: 'block' }}>
            {t(TILE_TITLE[tile.key])}
          </Typography.Text>
          <Typography.Title level={4} style={{ margin: '4px 0' }}>
            {tile.count}
          </Typography.Title>
          <Typography.Text type="secondary">
            {formatMoney(tile.moneyAtRisk, t)}
            {tile.unknownCount > 0 ? ` · ${tile.unknownCount} ${t(TEXT.unknown)}` : ''}
          </Typography.Text>
        </Button>
      </Card>
    ))}
  </Space>
);

export default React.memo(DashboardHeaderStrip);
