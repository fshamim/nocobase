/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * 066 T3 — the Issues cell of the Data-issues workbench (D3).
 *
 * The whole cell sits in the ONE shared `CellInteractive` wrapper (F9), so every
 * click and key press inside it — badge, inert tag, or open modal, which React
 * bubbles through the component tree even from a portal — stops before the row's
 * open-drawer handler. Row click opens the product drawer; badge click opens the
 * popup that resolves THAT issue. The two can never collide, keyboard included.
 *
 * Each resolvable issue is a real `<button>`: native Enter AND Space, a visible
 * focus ring, `aria-haspopup="dialog"` and an aria-label naming both the issue
 * and the listing. Everything else in the cluster stays an inert `Tag`.
 *
 * The label for `frozen_family_target_review` splits on `row.familyTargetAssigned`
 * (T2 field): a family with no target genuinely "needs a target", while a
 * non-target member of an already-targeted family is a "secondary listing" —
 * plan F5's 245 families, which the v1 badge told a falsehood.
 */

import { Tag, Tooltip } from 'antd';
import React, { useState } from 'react';
import type { DashboardRow } from '../server/contract';
import { reasonLabel, TEXT } from './dashboard-text';
import { DASHBOARD_TAG_COLORS } from './dashboard-tokens';
import { EvidenceModal, FamilyTargetModal } from './DataIssueModals';
import type { Translate } from './format';
import { CellInteractive } from './widgets/CellInteractive';
import type { PaneRenderContext } from './widgets/render-context';

const TARGET_REVIEW_CODE = 'frozen_family_target_review';
const EVIDENCE_CODE = 'missing_or_invalid_baseline_evidence';

type IssueKind = 'target' | 'evidence';

interface IssueBadge {
  code: string;
  kind: IssueKind;
  label: string;
  tone: 'warning' | 'neutral';
}

/**
 * Badge affordances. Buttons cannot be antd `Tag`s (a Tag is not a button), so
 * they carry the tag palette explicitly; the pending ghost is the same dashed
 * treatment the drawer's sync chip wears.
 */
const BADGE_TONES = {
  warning: { color: '#d46b08', background: '#fff7e6', border: '#ffd591' },
  neutral: { color: 'rgba(0,0,0,0.65)', background: '#fafafa', border: '#d9d9d9' },
} as const;

const BADGE_FOCUS_STYLE = `.ecobase-issue-badge:focus-visible { outline: 2px solid #1677ff; outline-offset: 1px; }`;

/**
 * The taxonomy's resolvable classes (1a/1b/2). Everything else — unknown codes,
 * a revived legacy vocabulary — returns null and renders inert, so gold can
 * grow new reason codes without this cell ever offering a fake fix.
 */
function issueBadgeFor(code: string, row: DashboardRow, t: Translate): IssueBadge | null {
  if (code === TARGET_REVIEW_CODE) {
    return row.familyTargetAssigned
      ? { code, kind: 'target', label: t(TEXT.issueSecondaryListing), tone: 'neutral' }
      : { code, kind: 'target', label: t(TEXT.issueNeedsTarget), tone: 'warning' };
  }
  if (code === EVIDENCE_CODE) {
    return { code, kind: 'evidence', label: reasonLabel(code, t), tone: 'warning' };
  }
  return null;
}

function IssueBadgeButton({
  badge,
  row,
  t,
  pending,
  onOpen,
}: {
  badge: IssueBadge;
  row: DashboardRow;
  t: Translate;
  pending: boolean;
  onOpen: () => void;
}) {
  const tone = BADGE_TONES[badge.tone];
  const sku = row.identity.sku ?? row.identity.asin ?? '';
  const button = (
    <button
      type="button"
      className="ecobase-issue-badge"
      disabled={pending}
      aria-disabled={pending}
      aria-haspopup="dialog"
      aria-label={`${t(TEXT.issueResolveAriaPrefix)} ${badge.label} — ${sku}`}
      onClick={onOpen}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: 11.5,
        lineHeight: 1.5,
        borderRadius: 999,
        padding: '1px 9px',
        width: 'fit-content',
        cursor: pending ? 'default' : 'pointer',
        // D8: a family whose edit is waiting for the publish cannot fire again.
        color: pending ? 'rgba(0,0,0,0.35)' : tone.color,
        background: pending ? 'transparent' : tone.background,
        border: `1px ${pending ? 'dashed' : 'solid'} ${pending ? '#d9d9d9' : tone.border}`,
      }}
    >
      {badge.label}
    </button>
  );
  // antd tooltips do not fire on a disabled control — the documented wrapper.
  return pending ? (
    <Tooltip title={t(TEXT.syncTooltip)}>
      <span style={{ display: 'inline-flex' }}>{button}</span>
    </Tooltip>
  ) : (
    button
  );
}

export function DataIssuesCell({ row, t, ctx }: { row: DashboardRow; t: Translate; ctx?: PaneRenderContext }) {
  const [openModal, setOpenModal] = useState<IssueKind | null>(null);
  const codes = Array.isArray(row.reasonCodes) ? row.reasonCodes : [];
  // Without a render context there is nothing to resolve WITH (no api client),
  // so the cluster degrades to the inert v1 rendering rather than to a dead button.
  const badges = ctx ? codes.map((code) => issueBadgeFor(code, row, t)) : codes.map(() => null);
  const pending = Boolean(ctx?.pendingFamilies.has(row.identity.familyKey));

  return (
    <CellInteractive>
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
        <style>{BADGE_FOCUS_STYLE}</style>
        {badges.map((badge, index) =>
          badge ? (
            <IssueBadgeButton
              key={`issue-${badge.code}-${index}`}
              badge={badge}
              row={row}
              t={t}
              pending={pending}
              onOpen={() => setOpenModal(badge.kind)}
            />
          ) : null,
        )}
        {/* Inert companions render AFTER the buttons (D3): unknown codes first,
            then the familySplit corroboration tag of taxonomy 1b. */}
        {codes.map((code, index) =>
          badges[index] ? null : (
            <Tag key={`inert-${code}-${index}`} color={DASHBOARD_TAG_COLORS.warning}>
              {reasonLabel(code, t)}
            </Tag>
          ),
        )}
        {row.familySplit ? <Tag color={DASHBOARD_TAG_COLORS.neutral}>{t(TEXT.badgeFamilySplit)}</Tag> : null}
        {ctx ? (
          <>
            <FamilyTargetModal
              open={openModal === 'target'}
              row={row}
              t={t}
              ctx={ctx}
              onClose={() => setOpenModal(null)}
            />
            <EvidenceModal
              open={openModal === 'evidence'}
              row={row}
              t={t}
              ctx={ctx}
              onClose={() => setOpenModal(null)}
            />
          </>
        ) : null}
      </span>
    </CellInteractive>
  );
}
