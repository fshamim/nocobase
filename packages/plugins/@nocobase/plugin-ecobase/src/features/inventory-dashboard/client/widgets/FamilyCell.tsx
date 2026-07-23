/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * W1 FamilyCell (T7, R1): tier pill (letter only) + bold ASIN anchor + muted
 * title + `company · marketplace` micro line + the inline target control.
 * The control lazy-fetches drawerContext for the family ON OPEN (one
 * operator-initiated request), lists the members, and requires a reason before
 * submitting `ecobaseInventoryDashboard:setFamilyTarget` (legacy modal
 * pattern: OK stays disabled until a reason is typed). W5's sync dot marks
 * rows whose edits await the next publish.
 */

import { App, Input, Modal, Radio, Space, Spin, Tag, Typography } from 'antd';
import React, { useState } from 'react';
import type { DashboardRow, DrawerContextResponse } from '../../server/contract';
import { isRunSuperseded } from '../../server/contract';
import { TEXT } from '../dashboard-text';
import { DASHBOARD_TAG_COLORS, TIER_TAG_COLOR } from '../dashboard-tokens';
import { isDrawerContextPayload, unwrapEnvelope } from '../envelope';
import type { Translate } from '../format';
import { CellInteractive } from './CellInteractive';
import type { PaneRenderContext } from './render-context';
import { SyncDot } from './SyncState';

type FamilyMember = DrawerContextResponse['familyMembers'][number];

export function FamilyCell({ row, t, ctx }: { row: DashboardRow; t: Translate; ctx?: PaneRenderContext }) {
  // T-R2 root cause: this coalesced baseline-first while the sort/badge rule
  // and every v1 renderer coalesce CURRENT-first — one canonical order now.
  const tier = (row.tier.current ?? row.tier.baseline ?? '').trim();
  const pending = Boolean(ctx?.pendingFamilies.has(row.identity.familyKey));
  const memberCount = row.familyMemberCount ?? 1;
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3, minWidth: 200 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        {tier ? (
          <Tag
            color={TIER_TAG_COLOR[tier.toLowerCase()] ?? DASHBOARD_TAG_COLORS.neutral}
            style={{ borderRadius: 999, marginInlineEnd: 0, paddingInline: 6, fontSize: 11, fontWeight: 600 }}
          >
            {tier.toUpperCase()}
          </Tag>
        ) : null}
        <Typography.Text strong>{row.identity.asin ?? ''}</Typography.Text>
        {pending ? <SyncDot t={t} /> : null}
      </span>
      {/* R1-5: the TARGET SKU is the working identity — prominent, not buried. */}
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
        <Typography.Text strong style={{ fontSize: 12.5 }}>
          {row.identity.sku ?? ''}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {`· ${memberCount} ${t(TEXT.listingsSuffix)}`}
        </Typography.Text>
      </span>
      {row.identity.title ? (
        <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 230 }}>
          {row.identity.title}
        </Typography.Text>
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 11, opacity: 0.75 }}>
        {[row.identity.company, row.identity.marketplace].filter(Boolean).join(' · ')}
      </Typography.Text>
      {ctx ? (
        <CellInteractive>
          <TargetControl row={row} t={t} ctx={ctx} memberCount={memberCount} />
        </CellInteractive>
      ) : null}
    </span>
  );
}

type MembersState = { status: 'idle' | 'loading' } | { status: 'loaded'; members: FamilyMember[] };

/**
 * The inline target picker. The current family-grain representative row IS the
 * persisted target (the server prefers it), so its SKU labels the control.
 */
function TargetControl({
  row,
  t,
  ctx,
  memberCount,
}: {
  row: DashboardRow;
  t: Translate;
  ctx: PaneRenderContext;
  memberCount: number;
}) {
  const { message } = App.useApp();
  const [membersState, setMembersState] = useState<MembersState>({ status: 'idle' });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<FamilyMember | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // R1-5: single-member families have nothing to choose — disabled, NO lazy fetch.
  const disabled = memberCount <= 1;

  const openPicker = async () => {
    if (disabled) return;
    setPickerOpen(true);
    if (membersState.status === 'loaded') return;
    setMembersState({ status: 'loading' });
    try {
      const data = unwrapEnvelope(
        await ctx.api.request({
          url: 'ecobaseInventoryDashboard:drawerContext',
          method: 'post',
          data: { pane: row.pane, runId: ctx.runId, familyId: row.identity.familyKey },
        }),
      );
      if (!isDrawerContextPayload(data) || isRunSuperseded(data)) throw new Error(t(TEXT.unexpectedResponse));
      setMembersState({ status: 'loaded', members: data.familyMembers });
    } catch (error) {
      setMembersState({ status: 'idle' });
      setPickerOpen(false);
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const submit = async () => {
    if (!selected?.companyProductId || !reason.trim()) return;
    setSubmitting(true);
    try {
      await ctx.api.request({
        url: 'ecobaseInventoryDashboard:setFamilyTarget',
        method: 'post',
        data: { familyId: row.identity.familyKey, companyProductId: selected.companyProductId, reason: reason.trim() },
      });
      ctx.markPending(row.identity.familyKey);
      message.success(t(TEXT.toastTargetChanged));
      setSelected(null);
      setReason('');
      setPickerOpen(false);
      ctx.onMutated(row.pane);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const members = membersState.status === 'loaded' ? membersState.members : [];
  const changeable = members.filter((member) => member.companyProductId);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={`${t(TEXT.btnChangeTarget)} ${row.identity.sku ?? ''}`}
        aria-disabled={disabled}
        onClick={openPicker}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          marginTop: 2,
          fontSize: 11.5,
          // R1-5 affordance: gray/no-op for single-member families, accent
          // border + caret (mockup .target style) when there is a real choice.
          color: disabled ? 'rgba(0,0,0,0.28)' : '#0958d9',
          background: 'transparent',
          border: `1px solid ${disabled ? '#e3e3e0' : '#91caff'}`,
          borderRadius: 999,
          padding: '1px 9px',
          width: 'fit-content',
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        {t(TEXT.btnChangeTarget)}
        <span aria-hidden style={{ fontSize: 9, opacity: disabled ? 0.4 : 0.9 }}>
          ▼
        </span>
      </button>
      <Modal
        open={pickerOpen}
        title={t(TEXT.drawerFamilyTarget)}
        onCancel={() => setPickerOpen(false)}
        onOk={submit}
        okText={t(TEXT.drawerSave)}
        okButtonProps={{ disabled: submitting || !selected?.companyProductId || !reason.trim() }}
        confirmLoading={submitting}
        destroyOnClose
      >
        {membersState.status === 'loading' ? (
          <Spin aria-label={t(TEXT.loading)} />
        ) : changeable.length < 2 ? (
          <Typography.Text type="secondary">{t(TEXT.onlyMemberNote)}</Typography.Text>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Radio.Group
              aria-label={t(TEXT.drawerFamilyTarget)}
              value={selected?.listingRowId}
              onChange={(event) => {
                setSelected(changeable.find((member) => member.listingRowId === event.target.value) ?? null);
              }}
            >
              <Space direction="vertical">
                {changeable.map((member) => (
                  <Radio key={member.listingRowId} value={member.listingRowId}>
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
    </>
  );
}
