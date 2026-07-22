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
import type { PaneRenderContext } from './render-context';
import { SyncDot } from './SyncState';

type FamilyMember = DrawerContextResponse['familyMembers'][number];

export function FamilyCell({ row, t, ctx }: { row: DashboardRow; t: Translate; ctx?: PaneRenderContext }) {
  const tier = (row.tier.baseline ?? row.tier.current ?? '').trim();
  const pending = Boolean(ctx?.pendingFamilies.has(row.identity.familyKey));
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
        <Typography.Text strong>{row.identity.asin ?? row.identity.sku ?? ''}</Typography.Text>
        {pending ? <SyncDot t={t} /> : null}
      </span>
      {row.identity.title ? (
        <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 230 }}>
          {row.identity.title}
        </Typography.Text>
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 11, opacity: 0.75 }}>
        {[row.identity.company, row.identity.marketplace].filter(Boolean).join(' · ')}
      </Typography.Text>
      {ctx ? <TargetControl row={row} t={t} ctx={ctx} /> : null}
    </span>
  );
}

type MembersState = { status: 'idle' | 'loading' } | { status: 'loaded'; members: FamilyMember[] };

/**
 * The inline target picker. The current family-grain representative row IS the
 * persisted target (the server prefers it), so its SKU labels the control.
 */
function TargetControl({ row, t, ctx }: { row: DashboardRow; t: Translate; ctx: PaneRenderContext }) {
  const { message } = App.useApp();
  const [membersState, setMembersState] = useState<MembersState>({ status: 'idle' });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<FamilyMember | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const openPicker = async () => {
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
        aria-label={`${t(TEXT.drawerFamilyTarget)}: ${row.identity.sku ?? ''}`}
        onClick={openPicker}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          marginTop: 2,
          fontSize: 11.5,
          color: 'rgba(0,0,0,0.48)',
          background: 'transparent',
          border: '1px solid #e3e3e0',
          borderRadius: 999,
          padding: '1px 9px',
          width: 'fit-content',
          cursor: 'pointer',
        }}
      >
        {`${t(TEXT.targetPrefix)} ${row.identity.sku ?? row.identity.asin ?? ''}`}
        <span aria-hidden style={{ fontSize: 9, opacity: 0.6 }}>
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
