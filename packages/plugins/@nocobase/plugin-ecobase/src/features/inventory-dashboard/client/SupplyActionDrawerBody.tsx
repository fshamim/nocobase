/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * T8b: the Supply Action drawer v2 (this pane ONLY — every other pane keeps
 * its v1 drawer). Identity header (NO database ids anywhere), the action bar
 * on top (all mutations go through the T8a `ecobaseInventoryDashboard:*`
 * actions), and four tabs: Overview (W7 chart + key numbers + full buckets),
 * Orders (T6 history), Comments (T6 thread + post box) and Data (lazy raw
 * record, fetched with includeRaw only on first open).
 */

import { Button, Input, InputNumber, Modal, Radio, Select, Space, Spin, Table, Tabs, Tag, Typography } from 'antd';
import React, { useRef, useState } from 'react';
import type { DashboardRow, DrawerCommentEntry, DrawerContextResponse } from '../server/contract';
import { TEXT } from './dashboard-text';
import { DASHBOARD_TAG_COLORS, TIER_TAG_COLOR, TREND_TAG_COLOR } from './dashboard-tokens';
import type { RunDrawerMutation } from './drawer-sections';
import { EM_DASH, formatMoney, formatMonthDay, type Translate } from './format';
import { ActionPill } from './widgets/ActionPill';
import { ProfitRangeChart } from './widgets/ProfitRangeChart';
import { StockBuckets } from './widgets/StockBuckets';

const TREND_TEXT: Record<string, string> = {
  up: TEXT.trendUp,
  flat: TEXT.trendFlat,
  down: TEXT.trendDown,
  unknown: TEXT.trendUnknown,
};

const ENTITY_TEXT: Record<DrawerCommentEntry['entityType'], string> = {
  product: TEXT.entityProduct,
  family: TEXT.entityFamily,
  order: TEXT.entityOrder,
  supplier: TEXT.entitySupplier,
};

export interface SupplyActionDrawerBodyProps {
  row: DashboardRow;
  context: DrawerContextResponse;
  familyId: string;
  orderId?: string;
  pendingSync: boolean;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
  loadSupplierOptions: (search?: string) => Promise<Array<{ label: string; value: string }>>;
  /** Data tab (D7): one includeRaw drawerContext fetch, only on first tab open. */
  fetchRaw: () => Promise<Record<string, unknown> | null>;
  now?: Date;
}

/** The primary row's mutation identity, resolved from context (never rendered). */
function primaryCompanyProductId(row: DashboardRow, context: DrawerContextResponse): string | null {
  const byListing = context.familyMembers.find((member) => member.listingRowId === row.identity.listingRowId);
  return byListing?.companyProductId ?? context.familyTarget?.companyProductId ?? null;
}

function relativeAge(at: string, t: Translate, now: Date): string {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return '';
  const hours = Math.floor((now.getTime() - parsed) / 3_600_000);
  if (hours < 1) return t(TEXT.relJustNow);
  if (hours < 24) return `${hours} ${t(TEXT.relHoursAgo)}`;
  if (hours < 48) return t(TEXT.relYesterday);
  return `${Math.floor(hours / 24)} ${t(TEXT.relDaysAgo)}`;
}

export function SupplyActionDrawerBody(props: SupplyActionDrawerBodyProps) {
  const { row, context, familyId, orderId, pendingSync, run, submitting, t, loadSupplierOptions, fetchRaw } = props;
  const now = props.now ?? new Date();
  const [activeTab, setActiveTab] = useState('overview');
  const commentInputRef = useRef<{ focus: () => void } | null>(null);
  // T-R2 root cause: this coalesced baseline-first while the sort/badge rule
  // and every v1 renderer coalesce CURRENT-first — one canonical order now.
  const tier = (row.tier.current ?? row.tier.baseline ?? '').trim();
  const companyProductId = primaryCompanyProductId(row, context);

  const focusComments = () => {
    setActiveTab('comments');
    setTimeout(() => commentInputRef.current?.focus(), 0);
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* Identity header — D1: no database ids anywhere. */}
      <Space wrap align="center" size={10}>
        {tier ? (
          <Tag
            color={TIER_TAG_COLOR[tier.toLowerCase()] ?? DASHBOARD_TAG_COLORS.neutral}
            style={{ borderRadius: 999, paddingInline: 6, fontSize: 11, fontWeight: 600, marginInlineEnd: 0 }}
          >
            {tier.toUpperCase()}
          </Tag>
        ) : null}
        <Typography.Text strong style={{ fontSize: 18 }}>
          {row.identity.asin ?? row.identity.sku ?? ''}
        </Typography.Text>
        <ActionPill row={row} t={t} />
        {pendingSync ? (
          <Tag bordered style={{ borderRadius: 999, borderStyle: 'dashed', color: 'rgba(0,0,0,0.45)' }}>
            {t(TEXT.syncChip)}
          </Tag>
        ) : null}
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {[row.identity.title, row.identity.sku, row.identity.company, row.identity.marketplace]
          .filter(Boolean)
          .join(' · ')}
      </Typography.Text>

      <ActionBar
        row={row}
        context={context}
        familyId={familyId}
        companyProductId={companyProductId}
        run={run}
        submitting={submitting}
        t={t}
        loadSupplierOptions={loadSupplierOptions}
        onComment={focusComments}
      />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'overview',
            label: t(TEXT.tabOverview),
            children: <OverviewTab row={row} context={context} t={t} />,
          },
          {
            key: 'orders',
            label: `${t(TEXT.tabOrders)} · ${context.orderHistory.length}`,
            children: <OrdersTab context={context} t={t} />,
          },
          {
            key: 'comments',
            label: `${t(TEXT.tabComments)} · ${context.commentThread.length}`,
            children: (
              <CommentsTab
                context={context}
                familyId={familyId}
                orderId={orderId}
                run={run}
                submitting={submitting}
                t={t}
                now={now}
                inputRef={commentInputRef}
              />
            ),
          },
          {
            key: 'data',
            label: t(TEXT.tabData),
            children: <DataTab active={activeTab === 'data'} fetchRaw={fetchRaw} t={t} />,
          },
        ]}
      />
    </Space>
  );
}

/* ------------------------------- action bar ------------------------------ */

interface ActionBarProps {
  row: DashboardRow;
  context: DrawerContextResponse;
  familyId: string;
  companyProductId: string | null;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
  loadSupplierOptions: (search?: string) => Promise<Array<{ label: string; value: string }>>;
  onComment: () => void;
}

function ActionBar(props: ActionBarProps) {
  const { row, context, familyId, companyProductId, run, submitting, t, loadSupplierOptions, onComment } = props;
  const [open, setOpen] = useState<'order' | 'target' | 'supplier' | 'leadTime' | 'status' | null>(null);
  const close = () => setOpen(null);
  return (
    <>
      <Space wrap role="toolbar" aria-label={t(TEXT.paneSupplyAction)}>
        <Button type="primary" disabled={submitting} onClick={() => setOpen('order')}>
          {t(TEXT.btnCreateOrder)}
        </Button>
        <Button disabled={submitting} onClick={() => setOpen('target')}>
          {t(TEXT.btnChangeTarget)}
        </Button>
        <Button disabled={submitting} onClick={() => setOpen('supplier')}>
          {t(TEXT.btnChangeSupplier)}
        </Button>
        <Button disabled={submitting || !row.supplier.id} onClick={() => setOpen('leadTime')}>
          {t(TEXT.btnUpdateLeadTime)}
        </Button>
        <Button disabled={submitting || !companyProductId} onClick={() => setOpen('status')}>
          {t(TEXT.btnSetStatus)}
        </Button>
        <Button disabled={submitting} onClick={onComment}>
          {t(TEXT.drawerComment)}
        </Button>
      </Space>
      <CreateOrderModal
        open={open === 'order'}
        row={row}
        companyProductId={companyProductId}
        run={run}
        t={t}
        loadSupplierOptions={loadSupplierOptions}
        onClose={close}
      />
      <ChangeTargetModal
        open={open === 'target'}
        context={context}
        familyId={familyId}
        run={run}
        t={t}
        onClose={close}
      />
      <ChangeSupplierModal
        open={open === 'supplier'}
        familyId={familyId}
        run={run}
        t={t}
        loadSupplierOptions={loadSupplierOptions}
        onClose={close}
      />
      <UpdateLeadTimeModal open={open === 'leadTime'} row={row} run={run} t={t} onClose={close} />
      <SetStatusModal open={open === 'status'} companyProductId={companyProductId} run={run} t={t} onClose={close} />
    </>
  );
}

function CreateOrderModal({
  open,
  row,
  companyProductId,
  run,
  t,
  loadSupplierOptions,
  onClose,
}: {
  open: boolean;
  row: DashboardRow;
  companyProductId: string | null;
  run: RunDrawerMutation;
  t: Translate;
  loadSupplierOptions: (search?: string) => Promise<Array<{ label: string; value: string }>>;
  onClose: () => void;
}) {
  const [qty, setQty] = useState<number | null>(row.recommendedOrderQty);
  const [supplierId, setSupplierId] = useState<string | undefined>(row.supplier.id ?? undefined);
  const [options, setOptions] = useState<Array<{ label: string; value: string }> | null>(null);
  const [unitCost, setUnitCost] = useState<number | null>(row.stock.unitCost);
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [expectedSellableDate, setExpectedSellableDate] = useState('');
  const [notes, setNotes] = useState('');
  const openOptions = async () => {
    if (options === null) setOptions(await loadSupplierOptions());
  };
  const submit = async () => {
    if (!companyProductId || !row.identity.company || qty === null || qty <= 0) return;
    const ok = await run('ecobaseInventoryDashboard:createPlannedOrder', {
      company: row.identity.company,
      planningProductId: companyProductId,
      supplierId,
      orderedQty: qty,
      unitCost: unitCost ?? undefined,
      expectedDeliveryDate: expectedDeliveryDate.trim() || undefined,
      expectedSellableDate: expectedSellableDate.trim() || undefined,
      notes: notes.trim() || undefined,
    });
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      title={t(TEXT.btnCreateOrder)}
      onCancel={onClose}
      onOk={submit}
      okText={t(TEXT.btnCreateOrder)}
      okButtonProps={{ disabled: !companyProductId || qty === null || qty <= 0 }}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <InputNumber
          aria-label={t(TEXT.qtyLabel)}
          min={1}
          value={qty}
          onChange={(value) => setQty(typeof value === 'number' ? value : null)}
          style={{ width: '100%' }}
        />
        <Select
          showSearch
          allowClear
          aria-label={t(TEXT.drawerSupplier)}
          placeholder={t(TEXT.drawerSupplier)}
          style={{ width: '100%' }}
          options={
            options ??
            (row.supplier.id && row.supplier.name ? [{ value: row.supplier.id, label: row.supplier.name }] : [])
          }
          optionFilterProp="label"
          value={supplierId}
          onDropdownVisibleChange={(visible) => {
            if (visible) openOptions();
          }}
          onChange={(value: string | undefined) => setSupplierId(value ?? undefined)}
        />
        <InputNumber
          aria-label={t(TEXT.colUnitCost)}
          min={0}
          value={unitCost}
          onChange={(value) => setUnitCost(typeof value === 'number' ? value : null)}
          style={{ width: '100%' }}
        />
        <Input
          aria-label={t(TEXT.expectedDeliveryLabel)}
          placeholder={t(TEXT.expectedDeliveryLabel)}
          value={expectedDeliveryDate}
          onChange={(event) => setExpectedDeliveryDate(event.target.value)}
        />
        <Input
          aria-label={t(TEXT.expectedSellableLabel)}
          placeholder={t(TEXT.expectedSellableLabel)}
          value={expectedSellableDate}
          onChange={(event) => setExpectedSellableDate(event.target.value)}
        />
        <Input.TextArea
          aria-label={t(TEXT.notesLabel)}
          placeholder={t(TEXT.notesLabel)}
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Space>
    </Modal>
  );
}

function ChangeTargetModal({
  open,
  context,
  familyId,
  run,
  t,
  onClose,
}: {
  open: boolean;
  context: DrawerContextResponse;
  familyId: string;
  run: RunDrawerMutation;
  t: Translate;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const changeable = context.familyMembers.filter((member) => member.companyProductId);
  const submit = async () => {
    if (!selected || !reason.trim()) return;
    const ok = await run('ecobaseInventoryDashboard:setFamilyTarget', {
      familyId,
      companyProductId: selected,
      reason: reason.trim(),
    });
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      title={t(TEXT.drawerFamilyTarget)}
      onCancel={onClose}
      onOk={submit}
      okText={t(TEXT.drawerSave)}
      okButtonProps={{ disabled: !selected || !reason.trim() }}
      destroyOnClose
    >
      {changeable.length < 2 ? (
        <Typography.Text type="secondary">{t(TEXT.onlyMemberNote)}</Typography.Text>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Radio.Group
            aria-label={t(TEXT.drawerFamilyTarget)}
            value={selected}
            onChange={(event) => setSelected(event.target.value as string)}
          >
            <Space direction="vertical">
              {changeable.map((member) => (
                <Radio key={member.listingRowId} value={member.companyProductId ?? ''}>
                  {`${member.sku ?? member.asin ?? ''}${member.isTarget ? ` — ${t(TEXT.targetPrefix)}` : ''}`}
                </Radio>
              ))}
            </Space>
          </Radio.Group>
          <Input
            aria-label={t(TEXT.reasonRequiredLabel)}
            placeholder={t(TEXT.reasonRequiredLabel)}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Space>
      )}
    </Modal>
  );
}

function ChangeSupplierModal({
  open,
  familyId,
  run,
  t,
  loadSupplierOptions,
  onClose,
}: {
  open: boolean;
  familyId: string;
  run: RunDrawerMutation;
  t: Translate;
  loadSupplierOptions: (search?: string) => Promise<Array<{ label: string; value: string }>>;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<Array<{ label: string; value: string }> | null>(null);
  const [supplierId, setSupplierId] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  // B3: server-driven typeahead — every keystroke queries the DB, so suppliers beyond
  // the first slice stay findable. The sequence guard drops stale async responses.
  const requestSeq = useRef(0);
  const load = async (search?: string) => {
    const seq = (requestSeq.current += 1);
    const loaded = await loadSupplierOptions(search);
    if (seq === requestSeq.current) setOptions(loaded);
  };
  const openOptions = async () => {
    if (options === null) await load();
  };
  const submit = async () => {
    if (!supplierId || !reason.trim()) return;
    const ok = await run('ecobaseInventoryDashboard:setFamilyPreferredSupplier', {
      familyId,
      supplierId,
      reason: reason.trim(),
    });
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      title={t(TEXT.drawerAssignSupplier)}
      onCancel={onClose}
      onOk={submit}
      okText={t(TEXT.drawerSave)}
      okButtonProps={{ disabled: !supplierId || !reason.trim() }}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select
          showSearch
          aria-label={t(TEXT.drawerAssignSupplier)}
          placeholder={t(TEXT.drawerAssignSupplier)}
          style={{ width: '100%' }}
          options={options ?? []}
          filterOption={false}
          onSearch={(text) => load(text)}
          value={supplierId}
          onDropdownVisibleChange={(visible) => {
            if (visible) openOptions();
          }}
          onChange={(value: string) => setSupplierId(value)}
        />
        <Input
          aria-label={t(TEXT.reasonRequiredLabel)}
          placeholder={t(TEXT.reasonRequiredLabel)}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Space>
    </Modal>
  );
}

function UpdateLeadTimeModal({
  open,
  row,
  run,
  t,
  onClose,
}: {
  open: boolean;
  row: DashboardRow;
  run: RunDrawerMutation;
  t: Translate;
  onClose: () => void;
}) {
  const [leadTimeDays, setLeadTimeDays] = useState<number | null>(row.supplier.leadTimeDays);
  const [notes, setNotes] = useState('');
  const submit = async () => {
    if (!row.identity.company || !row.supplier.id || leadTimeDays === null || leadTimeDays < 0) return;
    const ok = await run('ecobaseInventoryDashboard:updateSupplierLeadTime', {
      company: row.identity.company,
      supplierId: row.supplier.id,
      leadTimeDays,
      notes: notes.trim() || undefined,
    });
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      title={t(TEXT.btnUpdateLeadTime)}
      onCancel={onClose}
      onOk={submit}
      okText={t(TEXT.drawerSave)}
      okButtonProps={{ disabled: leadTimeDays === null || leadTimeDays < 0 }}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <InputNumber
          aria-label={t(TEXT.leadTimeDaysLabel)}
          min={0}
          value={leadTimeDays}
          onChange={(value) => setLeadTimeDays(typeof value === 'number' ? value : null)}
          style={{ width: '100%' }}
        />
        <Input.TextArea
          aria-label={t(TEXT.evidenceNotesLabel)}
          placeholder={t(TEXT.evidenceNotesLabel)}
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Space>
    </Modal>
  );
}

function SetStatusModal({
  open,
  companyProductId,
  run,
  t,
  onClose,
}: {
  open: boolean;
  companyProductId: string | null;
  run: RunDrawerMutation;
  t: Translate;
  onClose: () => void;
}) {
  const [planningIncluded, setPlanningIncluded] = useState<'included' | 'excluded' | undefined>(undefined);
  const [reorderCycleDays, setReorderCycleDays] = useState<number | null>(null);
  const [targetCoverDays, setTargetCoverDays] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const touched = planningIncluded !== undefined || reorderCycleDays !== null || targetCoverDays !== null;
  const submit = async () => {
    if (!companyProductId || !touched || !reason.trim()) return;
    const ok = await run('ecobaseInventoryDashboard:updateProductPlanningFields', {
      companyProductId,
      planningExcluded: planningIncluded === undefined ? undefined : planningIncluded === 'excluded',
      reorderCycleDays: reorderCycleDays ?? undefined,
      targetCoverDays: targetCoverDays ?? undefined,
      reason: reason.trim(),
    });
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      title={t(TEXT.btnSetStatus)}
      onCancel={onClose}
      onOk={submit}
      okText={t(TEXT.drawerSave)}
      okButtonProps={{ disabled: !companyProductId || !touched || !reason.trim() }}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select
          allowClear
          aria-label={t(TEXT.planningIncludedLabel)}
          placeholder={t(TEXT.planningIncludedLabel)}
          style={{ width: '100%' }}
          options={[
            { value: 'included', label: t(TEXT.includedOption) },
            { value: 'excluded', label: t(TEXT.excludedOption) },
          ]}
          value={planningIncluded}
          onChange={(value: 'included' | 'excluded' | undefined) => setPlanningIncluded(value ?? undefined)}
        />
        <InputNumber
          aria-label={t(TEXT.reorderCycleLabel)}
          placeholder={t(TEXT.reorderCycleLabel)}
          min={1}
          value={reorderCycleDays}
          onChange={(value) => setReorderCycleDays(typeof value === 'number' ? value : null)}
          style={{ width: '100%' }}
        />
        <InputNumber
          aria-label={t(TEXT.targetCoverLabel)}
          placeholder={t(TEXT.targetCoverLabel)}
          min={1}
          value={targetCoverDays}
          onChange={(value) => setTargetCoverDays(typeof value === 'number' ? value : null)}
          style={{ width: '100%' }}
        />
        <Input
          aria-label={t(TEXT.reasonRequiredLabel)}
          placeholder={t(TEXT.reasonRequiredLabel)}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Space>
    </Modal>
  );
}

/* --------------------------------- tabs --------------------------------- */

function OverviewTab({ row, context, t }: { row: DashboardRow; context: DrawerContextResponse; t: Translate }) {
  const trend = row.velocityTrend ?? 'unknown';
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space align="center" size={8}>
        <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: '0.07em', textTransform: 'uppercase' }}>
          {t(TEXT.chartTitle)}
        </Typography.Text>
        <Tag color={TREND_TAG_COLOR[trend]} style={{ borderRadius: 999 }}>
          {t(TREND_TEXT[trend])}
        </Tag>
      </Space>
      <ProfitRangeChart points={context.performanceEvidence} projectedMonthly={row.profit.projectedMonthly} t={t} />
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {`${t(TEXT.chartMonthlyProfit)} · ${t(TEXT.chartBestLegend)} · ${t(TEXT.chartWorstLegend)} · ${t(
          TEXT.chartDotsLegend,
        )}`}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: '0.07em', textTransform: 'uppercase' }}>
        {t(TEXT.keyNumbers)}
      </Typography.Text>
      <Space wrap size={10}>
        <Stat
          label={t(TEXT.statVelocity)}
          value={row.velocity.value !== null ? `${row.velocity.value.toFixed(1)}${t(TEXT.perDay)}` : EM_DASH}
          suffix={
            row.velocity.basis && row.velocity.basis !== 'rolling_30' && row.velocity.basis !== 'none'
              ? row.velocity.basis
              : undefined
          }
        />
        <Stat
          label={t(TEXT.colDaysOfCover)}
          value={
            row.daysOfCover !== null || row.positionDaysOfCover !== null
              ? `${Math.round(row.daysOfCover ?? row.positionDaysOfCover ?? 0)} ${t(TEXT.dSuffix)}`
              : EM_DASH
          }
        />
        <Stat
          label={t(TEXT.statProfitPerUnit)}
          value={row.profit.perUnit !== null ? formatMoney(row.profit.perUnit, t) : EM_DASH}
        />
        <Stat
          label={t(TEXT.statProfitPerMonth)}
          value={
            row.profit.projectedMonthly !== null
              ? formatMoney(row.profit.projectedMonthly, t)
              : row.profit.averageMonthly !== null
                ? formatMoney(row.profit.averageMonthly, t)
                : EM_DASH
          }
        />
        <Stat
          label={t(TEXT.drawerSupplier)}
          value={row.supplier.name ?? EM_DASH}
          suffix={
            row.supplier.leadTimeDays !== null
              ? `${row.supplier.leadTimeDays} ${t(TEXT.dSuffix)}${
                  row.supplier.leadTimeFreshness ? ` · ${row.supplier.leadTimeFreshness}` : ''
                }`
              : undefined
          }
        />
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: '0.07em', textTransform: 'uppercase' }}>
        {t(TEXT.stockBucketsTitle)}
      </Typography.Text>
      <StockBuckets stock={row.stock} t={t} variant="full" />
    </Space>
  );
}

function Stat({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        border: '1px solid #f0f0f0',
        borderRadius: 10,
        padding: '10px 12px',
        minWidth: 118,
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </Typography.Text>
      <Typography.Text strong style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography.Text>
      {suffix ? (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {suffix}
        </Typography.Text>
      ) : null}
    </span>
  );
}

function OrdersTab({ context, t }: { context: DrawerContextResponse; t: Translate }) {
  if (context.orderHistory.length === 0) {
    return <Typography.Text type="secondary">{t(TEXT.noOrdersYet)}</Typography.Text>;
  }
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {context.orderHistory.map((entry, index) => (
        <Space key={`${entry.orderDate ?? 'unknown'}-${index}`} size={12} style={{ fontSize: 12.5 }}>
          <Typography.Text type="secondary" style={{ minWidth: 72, fontVariantNumeric: 'tabular-nums' }}>
            {formatMonthDay(entry.orderDate)}
          </Typography.Text>
          <Typography.Text strong style={{ minWidth: 60, fontVariantNumeric: 'tabular-nums' }}>
            {entry.orderedQty !== null ? `${entry.orderedQty} u` : EM_DASH}
          </Typography.Text>
          <Typography.Text type="secondary">{entry.supplierName ?? EM_DASH}</Typography.Text>
          {entry.status ? (
            <Tag color={DASHBOARD_TAG_COLORS.neutral} style={{ borderRadius: 999 }}>
              {entry.status}
            </Tag>
          ) : null}
        </Space>
      ))}
      {context.maxEverOrderedQty !== null ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`${t(TEXT.maxEverPrefix)} ${context.maxEverOrderedQty}`}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

function CommentsTab({
  context,
  familyId,
  orderId,
  run,
  submitting,
  t,
  now,
  inputRef,
}: {
  context: DrawerContextResponse;
  familyId: string;
  orderId?: string;
  run: RunDrawerMutation;
  submitting: boolean;
  t: Translate;
  now: Date;
  inputRef: React.MutableRefObject<{ focus: () => void } | null>;
}) {
  const [body, setBody] = useState('');
  const submit = async () => {
    if (!body.trim()) return;
    // An order-context drawer comments the order; family-grain rows comment the family thread.
    const ok = orderId
      ? await run('ecobaseInventoryDashboard:addComment', { orderId, body: body.trim() })
      : await run('ecobaseInventoryDashboard:addProductComment', { familyId, body: body.trim() });
    if (ok) setBody('');
  };
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {context.commentThread.length === 0 ? (
        <Typography.Text type="secondary">{t(TEXT.noCommentsYet)}</Typography.Text>
      ) : (
        context.commentThread.map((comment, index) => (
          <span key={`${comment.at}-${index}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
              <Typography.Text strong style={{ fontSize: 11.5 }}>
                {comment.author ?? t(TEXT.unknown)}
              </Typography.Text>
              {` · ${relativeAge(comment.at, t, now)} · `}
              <Tag color={DASHBOARD_TAG_COLORS.neutral} style={{ borderRadius: 999, fontSize: 10.5 }}>
                {t(ENTITY_TEXT[comment.entityType])}
              </Tag>
            </Typography.Text>
            <Typography.Text
              style={{
                fontSize: 12.5,
                background: '#fafafa',
                border: '1px solid #f0f0f0',
                borderRadius: 10,
                padding: '7px 11px',
                width: 'fit-content',
                maxWidth: '100%',
              }}
            >
              {comment.body}
            </Typography.Text>
          </span>
        ))
      )}
      <Space.Compact style={{ width: '100%' }}>
        <Input
          ref={inputRef as React.Ref<never>}
          aria-label={t(TEXT.commentPlaceholder)}
          placeholder={t(TEXT.commentPlaceholder)}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onPressEnter={submit}
        />
        <Button type="primary" disabled={submitting || !body.trim()} onClick={submit}>
          {t(TEXT.btnPost)}
        </Button>
      </Space.Compact>
    </Space>
  );
}

type RawState = { status: 'idle' | 'loading' } | { status: 'loaded'; raw: Record<string, unknown> | null };

function DataTab({
  active,
  fetchRaw,
  t,
}: {
  active: boolean;
  fetchRaw: () => Promise<Record<string, unknown> | null>;
  t: Translate;
}) {
  const [state, setState] = useState<RawState>({ status: 'idle' });
  const [search, setSearch] = useState('');
  // D7 laziness: the includeRaw fetch happens on FIRST activation only.
  React.useEffect(() => {
    if (!active || state.status !== 'idle') return;
    setState({ status: 'loading' });
    fetchRaw()
      .then((raw) => setState({ status: 'loaded', raw }))
      .catch(() => setState({ status: 'loaded', raw: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  if (state.status !== 'loaded') {
    return active ? (
      <Spin aria-label={t(TEXT.loading)} />
    ) : (
      <Typography.Text type="secondary">{EM_DASH}</Typography.Text>
    );
  }
  const raw = state.raw ?? {};
  const needle = search.trim().toLowerCase();
  const rows = Object.entries(raw)
    .filter(([key]) => !needle || key.toLowerCase().includes(needle))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      key,
      value: typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? ''),
    }));
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Input.Search
        allowClear
        size="small"
        aria-label={t(TEXT.dataSearchPlaceholder)}
        placeholder={t(TEXT.dataSearchPlaceholder)}
        style={{ maxWidth: 280 }}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Table
        size="small"
        rowKey="key"
        pagination={false}
        columns={[
          { key: 'key', dataIndex: 'key', title: t(TEXT.dataField), width: 260 },
          {
            key: 'value',
            dataIndex: 'value',
            title: t(TEXT.dataValue),
            render: (value: string) => (
              <Typography.Text style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
                {value}
              </Typography.Text>
            ),
          },
        ]}
        dataSource={rows}
        scroll={{ y: 360 }}
      />
    </Space>
  );
}
