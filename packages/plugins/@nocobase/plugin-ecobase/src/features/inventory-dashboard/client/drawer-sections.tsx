/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Shared drawer sections (T-3.1..T-3.4). Pure presentational + small local
 * form buffers; every mutation goes through the drawer's `runMutation` so
 * error handling, double-submit protection, and scoped refresh stay uniform.
 */

import { Button, Descriptions, Input, InputNumber, Progress, Select, Space, Tag, Typography } from 'antd';
import React, { useState } from 'react';
import type { DashboardRow, DrawerContextResponse, MonthlyEvidencePoint } from '../server/contract';
import { DASHBOARD_CLICKUP_OPERATIONAL_STATUSES } from '../server/workflow-stage';
import { TEXT } from './dashboard-text';
import { DASHBOARD_TAG_COLORS, TIER_TAG_COLOR } from './dashboard-tokens';
import { formatDate, formatDays, formatMoney, formatNumber, type Translate } from './format';
import { recentTierOf } from './widgets/recent-tier';

/** Returns true on success; false when the mutation failed (buffers must be preserved). */
export type RunDrawerMutation = (url: string, data: Record<string, unknown>) => Promise<boolean>;

export function ProductSummary({ row, t }: { row: DashboardRow; t: Translate }) {
  // 065: the ONE badge rule reaches the v1 summary too — recent tier only.
  const tier = row.tier ? recentTierOf(row.tier) : null;
  return (
    <Descriptions column={2} size="small" title={t(TEXT.colProduct)}>
      <Descriptions.Item label="SKU">{row.identity?.sku ?? t(TEXT.unknown)}</Descriptions.Item>
      <Descriptions.Item label="ASIN">{row.identity?.asin ?? t(TEXT.unknown)}</Descriptions.Item>
      <Descriptions.Item label={t(TEXT.tier)}>
        {tier ? (
          <Tag color={TIER_TAG_COLOR[tier.tier.toLowerCase()] ?? DASHBOARD_TAG_COLORS.neutral}>
            {`${tier.tier.toUpperCase()}${tier.basis === 'last_month' ? ` · ${t(TEXT.tierLastMonthHint)}` : ''}`}
          </Tag>
        ) : (
          t(TEXT.unknown)
        )}
        {/* T-D5: the urgency badge also travels into the v1 drawer summary. */}
        {row.stockoutUrgency ? (
          <Tag color={DASHBOARD_TAG_COLORS.danger}>
            {row.stockoutUrgency.daysUntil <= 0
              ? t(TEXT.urgentStockoutNow)
              : `${t(TEXT.urgentStockoutWithin)} ${row.stockoutUrgency.daysUntil} ${t(TEXT.dSuffix)}`}
          </Tag>
        ) : null}
      </Descriptions.Item>
      <Descriptions.Item label={t(TEXT.colStock)}>{formatNumber(row.stock?.currentPlanningStock, t)}</Descriptions.Item>
      <Descriptions.Item label={t(TEXT.colDaysOfCover)}>{formatDays(row.daysOfCover, t)}</Descriptions.Item>
      <Descriptions.Item label={t(TEXT.colEstOos)}>{formatDate(row.estimatedOosDate, t)}</Descriptions.Item>
    </Descriptions>
  );
}

export function OrderSummary({ row, t }: { row: DashboardRow; t: Translate }) {
  if (!row.order) return null;
  return (
    <Descriptions column={2} size="small" title={t(TEXT.colOrder)}>
      <Descriptions.Item label={t(TEXT.colOrder)}>{row.order.orderNumber ?? row.order.orderId}</Descriptions.Item>
      <Descriptions.Item label={t(TEXT.drawerStatus)}>{row.order.clickupStatus ?? t(TEXT.unknown)}</Descriptions.Item>
      <Descriptions.Item label={t(TEXT.colDaysInStage)}>{formatDays(row.order.daysInStage, t)}</Descriptions.Item>
      <Descriptions.Item label={t(TEXT.drawerSupplier)}>{row.order.supplierName ?? t(TEXT.unknown)}</Descriptions.Item>
      <Descriptions.Item label={t(TEXT.colExpectedArrival)}>
        {formatDate(row.order.expectedArrivalDate, t)}
      </Descriptions.Item>
      <Descriptions.Item label={t(TEXT.colLastActivity)} span={2}>
        {row.lastActivity ? (
          <span>
            <Typography.Text>{row.lastActivity.preview || t(TEXT.unknown)}</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              {[row.lastActivity.author, row.lastActivity.at ? row.lastActivity.at.slice(0, 10) : null]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          </span>
        ) : (
          <Typography.Text type="secondary">{t(TEXT.noActivityYet)}</Typography.Text>
        )}
      </Descriptions.Item>
    </Descriptions>
  );
}

export function FamilyContext({ context, t }: { context: DrawerContextResponse; t: Translate }) {
  if (context.familyMembers.length <= 1) return null;
  return (
    <div>
      <Typography.Title level={5}>{t(TEXT.drawerFamilyListings)}</Typography.Title>
      <Space direction="vertical" size={4}>
        {context.familyMembers.map((member) => (
          <Typography.Text key={member.listingRowId}>
            {member.sku ?? member.asin ?? member.listingRowId} — {member.pane}
            {member.isTarget ? (
              <Tag color={DASHBOARD_TAG_COLORS.ok} style={{ marginLeft: 8 }}>
                {t(TEXT.drawerFamilyTarget)}
              </Tag>
            ) : null}
          </Typography.Text>
        ))}
      </Space>
    </div>
  );
}

export function CommentForm({
  orderId,
  run,
  submitting,
  t,
  label,
}: {
  orderId: string;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
  label?: string;
}) {
  const [body, setBody] = useState('');
  const submit = async () => {
    if (!body.trim()) return;
    const succeeded = await run('ecobaseOrderPlanning:addComment', { orderId, body: body.trim() });
    if (succeeded) setBody('');
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Input.TextArea
        rows={2}
        aria-label={t(TEXT.drawerComment)}
        placeholder={t(TEXT.drawerComment)}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <Button size="small" type="primary" disabled={submitting} onClick={submit}>
        {label ?? t(TEXT.drawerAddComment)}
      </Button>
    </Space>
  );
}

export function StatusForm({
  orderId,
  currentStatus,
  run,
  submitting,
  t,
}: {
  orderId: string;
  currentStatus: string | null;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
}) {
  const [status, setStatus] = useState<string | undefined>(undefined);
  const submit = async () => {
    if (!status) return;
    await run('ecobaseOrderPlanning:updateOrder', { orderId, fields: { lifecycleStatus: status } });
  };
  return (
    <Space wrap>
      <Select
        aria-label={t(TEXT.drawerChangeStatus)}
        placeholder={currentStatus ?? t(TEXT.drawerChangeStatus)}
        style={{ minWidth: 220 }}
        value={status}
        options={DASHBOARD_CLICKUP_OPERATIONAL_STATUSES.map((value) => ({ label: value, value }))}
        onChange={(value: string) => setStatus(value)}
      />
      <Button size="small" disabled={submitting} onClick={submit}>
        {t(TEXT.drawerChangeStatus)}
      </Button>
    </Space>
  );
}

export function PrepDetailsForm({
  orderId,
  run,
  submitting,
  t,
}: {
  orderId: string;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
}) {
  const [boxes, setBoxes] = useState<number | null>(null);
  const [cartons, setCartons] = useState<number | null>(null);
  const [length, setLength] = useState<number | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const submit = async () => {
    const prepDimensions =
      length !== null || width !== null || height !== null ? { unit: 'cm', length, width, height } : undefined;
    await run('ecobaseInventoryDashboard:savePrepDetails', {
      orderId,
      prepBoxes: boxes ?? undefined,
      prepCartons: cartons ?? undefined,
      prepDimensions,
    });
  };
  return (
    <Space direction="vertical">
      <Typography.Title level={5}>{t(TEXT.drawerPrepDetails)}</Typography.Title>
      <Space wrap>
        <InputNumber
          aria-label={t(TEXT.drawerBoxes)}
          placeholder={t(TEXT.drawerBoxes)}
          min={0}
          value={boxes}
          onChange={setBoxes}
        />
        <InputNumber
          aria-label={t(TEXT.drawerCartons)}
          placeholder={t(TEXT.drawerCartons)}
          min={0}
          value={cartons}
          onChange={setCartons}
        />
        <InputNumber aria-label="L" placeholder="L" min={0} value={length} onChange={setLength} />
        <InputNumber aria-label="W" placeholder="W" min={0} value={width} onChange={setWidth} />
        <InputNumber aria-label="H" placeholder="H" min={0} value={height} onChange={setHeight} />
      </Space>
      <Button size="small" type="primary" disabled={submitting} onClick={submit}>
        {t(TEXT.drawerSavePrepDetails)}
      </Button>
    </Space>
  );
}

export function ShipRouteForm({
  supplierId,
  current,
  run,
  submitting,
  t,
}: {
  supplierId: string;
  current: 'direct_fba' | 'prep_center' | null;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
}) {
  const [destination, setDestination] = useState<'direct_fba' | 'prep_center' | undefined>(current ?? undefined);
  const submit = async () => {
    if (!destination) return;
    await run('ecobaseInventoryDashboard:saveSupplierShipDestination', { supplierId, shipDestination: destination });
  };
  return (
    <Space wrap>
      <Typography.Text>{t(TEXT.drawerShipRoute)}</Typography.Text>
      <Select
        aria-label={t(TEXT.drawerShipRoute)}
        style={{ minWidth: 220 }}
        value={destination}
        options={[
          { label: t(TEXT.drawerShipsDirect), value: 'direct_fba' },
          { label: t(TEXT.drawerShipsPrepCenter), value: 'prep_center' },
        ]}
        onChange={(value: 'direct_fba' | 'prep_center') => setDestination(value)}
      />
      <Button size="small" disabled={submitting} onClick={submit}>
        {t(TEXT.drawerSave)}
      </Button>
    </Space>
  );
}

export function EtaForm({
  orderId,
  run,
  submitting,
  t,
}: {
  orderId: string;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
}) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const submit = async () => {
    if (!date.trim() || !reason.trim()) return;
    await run('ecobaseOrderPlanning:updateOrder', {
      orderId,
      fields: { expectedDeliveryDate: date.trim() },
      commentBody: reason.trim(),
    });
  };
  return (
    <Space direction="vertical">
      <Typography.Title level={5}>{t(TEXT.drawerAdjustEta)}</Typography.Title>
      <Space wrap>
        <Input
          aria-label={t(TEXT.drawerAdjustEta)}
          placeholder="YYYY-MM-DD"
          style={{ width: 140 }}
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <Input
          aria-label={t(TEXT.drawerReason)}
          placeholder={t(TEXT.drawerReason)}
          style={{ width: 220 }}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button size="small" disabled={submitting} onClick={submit}>
          {t(TEXT.drawerSave)}
        </Button>
      </Space>
      <Typography.Text type="secondary">{t(TEXT.drawerBufferExplanation)}</Typography.Text>
    </Space>
  );
}

export function BandVisual({ points, t }: { points: MonthlyEvidencePoint[]; t: Translate }) {
  const trusted = points.filter((point): point is MonthlyEvidencePoint & { units: number } =>
    Boolean(point.trusted && typeof point.units === 'number'),
  );
  if (trusted.length === 0) {
    return <Typography.Text type="secondary">{t(TEXT.bandInsufficient)}</Typography.Text>;
  }
  const best = Math.max(...trusted.map((point) => point.units));
  return (
    <div>
      <Typography.Title level={5}>{t(TEXT.drawerBandTitle)}</Typography.Title>
      <Space direction="vertical" style={{ width: '100%' }} size={2}>
        {trusted.map((point, index) => (
          <Space key={point.month ?? index} style={{ width: '100%' }}>
            <Typography.Text style={{ width: 70, display: 'inline-block' }}>{point.month ?? '—'}</Typography.Text>
            <Progress
              percent={best > 0 ? Math.round((point.units / best) * 100) : 0}
              size="small"
              style={{ width: 220 }}
              format={() => `${point.units}`}
            />
          </Space>
        ))}
      </Space>
    </div>
  );
}

/*
 * 066 D4: `AssignSupplierForm` and `ReasonList` were deleted here. Both existed
 * only for the v1 dataReadiness drawer body, which is gone now that the pane
 * opens the rich `SupplyActionDrawerBody`: supplier assignment lives in that
 * body's Change-supplier modal (same `setFamilyPreferredSupplier` mutation,
 * covered by supply-action-drawer.test.tsx) and the reason codes render in its
 * "Why it's here" strip (063 D6).
 */
