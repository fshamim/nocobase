/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * 066 T3 — the two resolution popups behind the Data-issues badges (D6 + D7).
 *
 * Both follow the shipped cell-modal contract (D5, the `TargetControl` pattern):
 * open → lazy `drawerContext` fetch with an in-modal spinner → resolution form →
 * an EXISTING mutation → on success `markPending` + `onMutated` + toast + close.
 * A failure keeps the modal open with the error visible and fires no refresh, so
 * a typed reason is never lost to a network blip.
 *
 * D8 honesty: nothing here removes the row. Gold reclassifies only when the
 * debounced publish lands; until then the family is pending and its badges are
 * disabled ghosts.
 */

import { Alert, App, Button, Input, Modal, Radio, Space, Spin, Tag, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import type { DashboardRow, DrawerContextResponse } from '../server/contract';
import { isRunSuperseded } from '../server/contract';
import { paneTitle, reasonLabel, TEXT } from './dashboard-text';
import { DASHBOARD_TAG_COLORS } from './dashboard-tokens';
import { isDrawerContextPayload, unwrapEnvelope } from './envelope';
import { EM_DASH, type Translate } from './format';
import type { PaneRenderContext } from './widgets/render-context';

type FamilyMember = DrawerContextResponse['familyMembers'][number];

type ContextState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; context: DrawerContextResponse }
  | { status: 'error'; message: string };

/** The pane this cell only ever renders in — the scope of every refresh it triggers. */
const PANE: DashboardRow['pane'] = 'dataReadiness';

/** How many closed months the evidence strip shows (D7). */
const EVIDENCE_MONTHS = 6;

/**
 * D5: ONE operator-initiated fetch per modal, on open. Both popups need the same
 * family context (members + target provenance + monthly evidence), so they share
 * the loader instead of each growing its own copy of the error/retry handling.
 */
function useDrawerContext(open: boolean, row: DashboardRow, ctx: PaneRenderContext, t: Translate) {
  const [state, setState] = useState<ContextState>({ status: 'idle' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = unwrapEnvelope(
        await ctx.api.request({
          url: 'ecobaseInventoryDashboard:drawerContext',
          method: 'post',
          data: {
            pane: row.pane,
            runId: ctx.runId,
            familyId: row.identity.familyKey,
            listingRowId: row.identity.listingRowId,
          },
        }),
      );
      if (!isDrawerContextPayload(data) || isRunSuperseded(data)) throw new Error(t(TEXT.unexpectedResponse));
      setState({ status: 'loaded', context: data });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [ctx.api, ctx.runId, row.identity.familyKey, row.identity.listingRowId, row.pane, t]);

  useEffect(() => {
    if (open && state.status === 'idle') load();
  }, [open, state.status, load]);

  return { state, reload: load };
}

/** Loading + error chrome shared by both popups (retry re-runs the same fetch). */
function ContextGate({ state, reload, t }: { state: ContextState; reload: () => void; t: Translate }) {
  if (state.status === 'error') {
    return (
      <Alert
        type="error"
        showIcon
        message={`${t(TEXT.loadFailed)}: ${state.message}`}
        action={
          <Button size="small" onClick={reload}>
            {t(TEXT.retry)}
          </Button>
        }
      />
    );
  }
  return <Spin aria-label={t(TEXT.loading)} />;
}

function memberLabel(member: FamilyMember, t: Translate): string {
  const identity = [member.sku, member.asin].filter(Boolean).join(' · ') || member.listingRowId;
  const target = member.isTarget ? ` · ${t(TEXT.targetPrefix)}` : '';
  return `${identity} — ${t(paneTitle(member.pane))}${target}`;
}

/**
 * D6 — the family-target popup, reached from BOTH badge variants. It renders by
 * the ACTUAL fetched state, never by the badge label: a row can wear "Needs
 * target" only until the fetch says otherwise, and the has-target panel is the
 * honest answer for the 245 shadow-member families of plan F5.
 */
export function FamilyTargetModal({
  open,
  row,
  t,
  ctx,
  onClose,
}: {
  open: boolean;
  row: DashboardRow;
  t: Translate;
  ctx: PaneRenderContext;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { state, reload } = useDrawerContext(open, row, ctx, t);
  const [selectedListingRowId, setSelectedListingRowId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const context = state.status === 'loaded' ? state.context : null;
  // Only members carrying a companyProductId are addressable by `setFamilyTarget`.
  const members = (context?.familyMembers ?? []).filter((member) => member.companyProductId);
  const familyTarget = context?.familyTarget ?? null;
  const hasTarget = Boolean(familyTarget?.companyProductId);
  const targetMember =
    members.find((member) => member.companyProductId === familyTarget?.companyProductId) ??
    members.find((member) => member.isTarget) ??
    null;

  // F6: the single-member family is the capability today's pickers refuse — its
  // one member is pre-selected and shown read-only, so confirming is one click.
  const onlyMember = !hasTarget && members.length === 1 ? members[0] : null;
  const selected = onlyMember ?? members.find((member) => member.listingRowId === selectedListingRowId) ?? null;

  const close = () => {
    setSelectedListingRowId(null);
    setReason('');
    setExpanded(false);
    onClose();
  };

  const submit = async () => {
    const companyProductId = selected?.companyProductId;
    if (!companyProductId || !reason.trim()) return;
    setSubmitting(true);
    try {
      await ctx.api.request({
        url: 'ecobaseInventoryDashboard:setFamilyTarget',
        method: 'post',
        data: { familyId: row.identity.familyKey, companyProductId, reason: reason.trim() },
      });
      // D8: the row stays put — it is marked pending until the publish lands.
      ctx.markPending(row.identity.familyKey);
      message.success(t(TEXT.toastTargetChanged));
      ctx.onMutated(PANE);
      close();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const picker = (
    <Space direction="vertical" style={{ width: '100%' }}>
      {members.length > 1 ? (
        <Radio.Group
          aria-label={t(TEXT.drawerFamilyTarget)}
          value={selected?.listingRowId}
          onChange={(event) => setSelectedListingRowId(event.target.value as string)}
        >
          <Space direction="vertical">
            {members.map((member) => (
              <Radio key={member.listingRowId} value={member.listingRowId}>
                {memberLabel(member, t)}
              </Radio>
            ))}
          </Space>
        </Radio.Group>
      ) : null}
      <Input
        aria-label={t(TEXT.reasonRequiredLabel)}
        placeholder={t(TEXT.reasonRequiredLabel)}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
    </Space>
  );

  return (
    <Modal
      open={open}
      title={t(TEXT.drawerFamilyTarget)}
      onCancel={close}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={close}>
          {t(TEXT.ocCancel)}
        </Button>,
        // D6.3: nothing pretends to resolve a family that already HAS a target —
        // the change-target form (and its submit) appear only when asked for.
        hasTarget && !expanded ? (
          <Button key="expand" type="primary" onClick={() => setExpanded(true)}>
            {t(TEXT.btnChangeTarget)}
          </Button>
        ) : (
          <Button
            key="ok"
            type="primary"
            loading={submitting}
            disabled={!selected?.companyProductId || !reason.trim() || submitting}
            onClick={submit}
          >
            {t(TEXT.drawerSave)}
          </Button>
        ),
      ]}
    >
      {state.status !== 'loaded' ? (
        <ContextGate state={state} reload={reload} t={t} />
      ) : hasTarget ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text strong>{t(TEXT.targetAssignedElsewhere)}</Typography.Text>
          <Typography.Text>
            {`${t(TEXT.drawerFamilyTarget)}: ${targetMember ? memberLabel(targetMember, t) : EM_DASH}`}
          </Typography.Text>
          {familyTarget?.selectionRule || familyTarget?.selectionSource ? (
            <Typography.Text type="secondary">
              {familyTarget?.selectionRule ?? familyTarget?.selectionSource}
            </Typography.Text>
          ) : null}
          <Typography.Text type="secondary">{t(TEXT.targetSecondaryExplain)}</Typography.Text>
          {expanded ? picker : null}
        </Space>
      ) : onlyMember ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>{t(TEXT.targetConfirmOnlyMember)}</Typography.Text>
          <Typography.Text strong>{memberLabel(onlyMember, t)}</Typography.Text>
          <Typography.Text type="secondary">{t(TEXT.onlyMemberNote)}</Typography.Text>
          {picker}
        </Space>
      ) : (
        picker
      )}
    </Modal>
  );
}

/** Same resolution the drawer uses: the clicked listing first, else the family target. */
function primaryCompanyProductId(row: DashboardRow, context: DrawerContextResponse): string | null {
  const byListing = context.familyMembers.find((member) => member.listingRowId === row.identity.listingRowId);
  return byListing?.companyProductId ?? context.familyTarget?.companyProductId ?? null;
}

/**
 * D7 — the "no usable sales history" explainer (taxonomy class (c)). There is no
 * fix button because there is no operator fix: the popup states what the engine
 * sees, shows the closed-month evidence, names the usual causes, and offers the
 * two real actions — open the product drawer, or log the investigation as a
 * comment.
 */
export function EvidenceModal({
  open,
  row,
  t,
  ctx,
  onClose,
}: {
  open: boolean;
  row: DashboardRow;
  t: Translate;
  ctx: PaneRenderContext;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { state, reload } = useDrawerContext(open, row, ctx, t);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);

  const context = state.status === 'loaded' ? state.context : null;
  const companyProductId = context ? primaryCompanyProductId(row, context) : null;
  const months = (context?.performanceEvidence ?? []).slice(-EVIDENCE_MONTHS);
  const velocity = row.velocity;

  // Served row fields only — the pane never fetches a second time to explain itself.
  const stateRows: Array<[string, string]> = [
    [t(TEXT.drawerWhyHere), (row.reasonCodes ?? []).map((code) => reasonLabel(code, t)).join(' · ') || EM_DASH],
    [t(TEXT.statVelocity), velocity.value === null ? EM_DASH : `${velocity.value.toFixed(1)}${t(TEXT.perDay)}`],
    [t(TEXT.evidenceBasisLabel), velocity.basis ?? EM_DASH],
    [t(TEXT.evidenceConfidenceLabel), velocity.confidence ?? EM_DASH],
    [t(TEXT.evidenceStatusLabel), velocity.evidenceStatus ?? EM_DASH],
    [
      t(TEXT.evidenceObservedLabel),
      velocity.observedDays === null ? EM_DASH : `${velocity.observedDays} ${t(TEXT.observedOf30DaysSuffix)}`,
    ],
    [t(TEXT.evidenceAsOfLabel), velocity.asOfDate ?? EM_DASH],
  ];

  const postComment = async () => {
    if (!body.trim()) return;
    setPosting(true);
    try {
      await ctx.api.request({
        url: 'ecobaseInventoryDashboard:addProductComment',
        method: 'post',
        // The listing's own product when context resolved it; the family thread
        // otherwise — the server accepts either identity.
        data: companyProductId
          ? { companyProductId, body: body.trim() }
          : { familyId: row.identity.familyKey, body: body.trim() },
      });
      message.success(t(TEXT.toastCommentPosted));
      setBody('');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPosting(false);
    }
  };

  const openProductDrawer = () => {
    onClose();
    ctx.openDrawer?.(row);
  };

  return (
    <Modal
      open={open}
      title={t(TEXT.evidenceModalTitle)}
      onCancel={onClose}
      destroyOnClose
      footer={[
        <Button key="close" onClick={onClose}>
          {t(TEXT.ocCancel)}
        </Button>,
        ctx.openDrawer ? (
          <Button key="drawer" type="primary" onClick={openProductDrawer}>
            {t(TEXT.evidenceOpenDrawer)}
          </Button>
        ) : null,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text>{t(TEXT.evidenceIntro)}</Typography.Text>

        <div>
          <Typography.Text strong>{t(TEXT.evidenceStateHeading)}</Typography.Text>
          <dl style={{ margin: '4px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px' }}>
            {stateRows.map(([label, value]) => (
              <React.Fragment key={label}>
                <dt style={{ margin: 0 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    {label}
                  </Typography.Text>
                </dt>
                <dd style={{ margin: 0 }}>
                  <Typography.Text style={{ fontSize: 12.5 }}>{value}</Typography.Text>
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </div>

        <div>
          <Typography.Text strong>{t(TEXT.evidenceMonthsHeading)}</Typography.Text>
          {state.status !== 'loaded' ? (
            <div style={{ marginTop: 4 }}>
              <ContextGate state={state} reload={reload} t={t} />
            </div>
          ) : months.length === 0 ? (
            <div>
              <Typography.Text type="secondary">{t(TEXT.evidenceNoMonths)}</Typography.Text>
            </div>
          ) : (
            <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
              {months.map((point, index) => (
                <li key={point.month ?? `month-${index}`}>
                  <Typography.Text style={{ fontSize: 12.5 }}>
                    {`${point.month ?? EM_DASH} · ${point.units ?? EM_DASH} ${t(TEXT.unitsSuffix)} `}
                  </Typography.Text>
                  <Tag color={point.trusted ? DASHBOARD_TAG_COLORS.ok : DASHBOARD_TAG_COLORS.neutral}>
                    {point.trusted ? t(TEXT.evidenceTrusted) : t(TEXT.evidenceUntrusted)}
                  </Tag>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <Typography.Text strong>{t(TEXT.evidenceCausesHeading)}</Typography.Text>
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
            {[TEXT.evidenceCauseNewProduct, TEXT.evidenceCauseNoImport, TEXT.evidenceCauseRollover].map((cause) => (
              <li key={cause}>
                <Typography.Text style={{ fontSize: 12.5 }}>{t(cause)}</Typography.Text>
              </li>
            ))}
          </ul>
        </div>

        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Input.TextArea
            aria-label={t(TEXT.drawerAddComment)}
            placeholder={t(TEXT.commentPlaceholder)}
            rows={2}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <Button size="small" disabled={!body.trim() || posting} loading={posting} onClick={postComment}>
            {t(TEXT.btnPost)}
          </Button>
        </Space>
      </Space>
    </Modal>
  );
}
