/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Alert, Card, Descriptions, Space, Tag, Typography } from 'antd';
import React, { useMemo, useState } from 'react';

export type EvidenceTranslator = (value: string) => string;
type PlainRecord = Record<string, any>;

export interface CorrectedInventoryEvidenceRow extends PlainRecord {
  companyProductId: string;
  companyProductFamilyId: string;
  baselineTier: 'A' | 'B' | 'C' | 'D' | null;
  baselineState: string;
  baselineConfidence: string;
  averageMonthlyProfit: string | null;
  averageMonthlyUnits: string | null;
  replenishmentEligibility: string;
  listingReviewCategories: string[];
  monthlyPerformanceEvidence: Array<{
    monthStart: string;
    monthlyTierScore: string | null;
    monthlyUnits: string | null;
    monthlyProfit: string | null;
  }>;
}

export interface CorrectedFamilyActionEvidenceRow extends CorrectedInventoryEvidenceRow {
  targetCompanyProductId: string | null;
  actionSourceCompanyProductId: string | null;
  representativeCompanyProductId: string;
  primaryActionPane: string;
  replenishmentBlockReasonCode: string;
  newReplenishmentActionable: boolean;
  existingOrderFollowUp: boolean;
}

const REVIEW_CATEGORIES = [
  'tier_d',
  'no_movement',
  'closed_decline',
  'projected_decline',
  'stuck',
  'excess',
  'data_readiness',
] as const;

function text(value: unknown) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function evidenceRows(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is PlainRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

export function CorrectedInventoryEvidencePanel({
  row,
  t,
}: {
  row: CorrectedInventoryEvidenceRow;
  t: EvidenceTranslator;
}) {
  const monthly = evidenceRows(row.monthlyPerformanceEvidence);
  const members = evidenceRows(row.memberPerformanceEvidence);
  const categories = Array.isArray(row.listingReviewCategories) ? row.listingReviewCategories.map(String) : [];
  return (
    <section aria-label={t('Corrected individual listing performance')}>
      <Card title={t('Individual monthly performance')} size="small">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Tag color="blue">
              {t('Baseline')} {text(row.baselineTier)}
            </Tag>
            <Typography.Text>
              {text(row.baselineTierScore)} · {t(text(row.baselineConfidence))} {t('confidence')}
            </Typography.Text>
            <Tag>{t(text(row.baselineState))}</Tag>
          </Space>

          <div aria-label={t('Ordered closed-month performance')}>
            <Typography.Text strong>{t('Closed-month history')}</Typography.Text>
            <Space wrap style={{ marginLeft: 8 }}>
              {monthly.length ? (
                monthly.map((item) => (
                  <Tag key={text(item.monthStart)}>
                    {text(item.monthStart)} · {t('Score')} {text(item.monthlyTierScore)} · {t('Units')}{' '}
                    {text(item.monthlyUnits)} · {t('Profit')} {text(item.monthlyProfit)}
                  </Tag>
                ))
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              )}
            </Space>
          </div>

          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label={t('Last closed month')}>
              {t('Closed')} {text(row.lastClosedMonthTier)} · {text(row.lastClosedMonth)} ·{' '}
              {t(text(row.closedTierMovement))}
            </Descriptions.Item>
            <Descriptions.Item label={t('Current projection')}>
              {t('Current projected')} {text(row.currentProjectedTier)} · {text(row.currentProjectedTierScore)} ·{' '}
              {t(text(row.currentProjectionConfidence))} · {t(text(row.projectedTierMovement))}
            </Descriptions.Item>
            <Descriptions.Item label={t('Quantity range')}>
              {t('Average units')} {text(row.averageMonthlyUnits)} · {t('Best units')} {text(row.bestMonthlyUnits)} ·{' '}
              {t('Worst units')} {text(row.worstMonthlyUnits)}
            </Descriptions.Item>
            <Descriptions.Item label={t('Profit range')}>
              {t('Average profit')} {text(row.averageMonthlyProfit)} · {t('Best profit')} {text(row.bestMonthlyProfit)}{' '}
              · {t('Worst profit')} {text(row.worstMonthlyProfit)}
            </Descriptions.Item>
            <Descriptions.Item label={t('Pace status')}>
              {t('Quantity pace')} {text(row.quantityPaceStatus)} · {t('Profit pace')} {text(row.profitPaceStatus)} ·{' '}
              {t('Aggregate')} {text(row.aggregatePaceStatus)} ({text(row.paceCause)})
            </Descriptions.Item>
            <Descriptions.Item label={t('Disposition and replenishment')}>
              {t('Disposition')} {text(row.inventoryDisposition)} · {t('Replenishment')}{' '}
              {text(row.replenishmentEligibility)} · {text(row.replenishmentBlockReasonCode)}
            </Descriptions.Item>
          </Descriptions>

          {row.existingOrderFollowUp === true ? (
            <Alert
              type="warning"
              showIcon
              message={t('Existing order follow-up')}
              description={t(text(row.existingOrderFollowUpAction))}
            />
          ) : null}

          {categories.length ? (
            <Space wrap aria-label={t('Non-action listing review categories')}>
              {categories.map((category) => (
                <Tag key={category}>{t(category)}</Tag>
              ))}
            </Space>
          ) : null}

          {members.length ? (
            <div aria-label={t('Linked member performance')}>
              <Typography.Text strong>{t('Linked member performance')}</Typography.Text>
              <ul>
                {members.map((member) => (
                  <li key={text(member.companyProductId)}>
                    {t('Linked member')} {text(member.companyProductId)} · {t('Baseline')} {text(member.baselineTier)} ·{' '}
                    {t('Disposition')} {text(member.inventoryDisposition)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Space>
      </Card>
    </section>
  );
}

export function CandidatePreviewPanel({
  runId,
  banner,
  rows,
  familyActions,
  t,
}: {
  runId: string;
  banner: string;
  rows: CorrectedInventoryEvidenceRow[];
  familyActions: CorrectedFamilyActionEvidenceRow[];
  t: EvidenceTranslator;
}) {
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const filteredRows = useMemo(() => {
    if (!selectedCategories.length) return rows;
    return rows.filter((row) => {
      const categories = Array.isArray(row.listingReviewCategories) ? row.listingReviewCategories.map(String) : [];
      return selectedCategories.some((category) => categories.includes(category));
    });
  }, [rows, selectedCategories]);
  const selectedRow =
    filteredRows.find((row) => text(row.companyProductId ?? row.naturalKey) === selectedKey) ?? filteredRows[0];
  const selectedFamilyMembers = selectedRow
    ? rows
        .filter(
          (row) =>
            text(row.companyProductFamilyId ?? row.companyProductId) ===
            text(selectedRow.companyProductFamilyId ?? selectedRow.companyProductId),
        )
        .map((row) => ({
          companyProductId: row.companyProductId,
          baselineTier: row.baselineTier,
          baselineTierScore: row.baselineTierScore,
          baselineState: row.baselineState,
          baselineConfidence: row.baselineConfidence,
          inventoryDisposition: row.inventoryDisposition,
          replenishmentEligibility: row.replenishmentEligibility,
          primaryActionPane: row.primaryActionPane,
          listingReviewCategories: row.listingReviewCategories,
        }))
    : [];
  const selectedEvidence = selectedRow
    ? {
        ...selectedRow,
        memberPerformanceEvidence: selectedRow.memberPerformanceEvidence ?? selectedFamilyMembers,
      }
    : undefined;
  const selectedFamilyAction = selectedRow
    ? familyActions.find((action) => action.companyProductFamilyId === selectedRow.companyProductFamilyId)
    : undefined;
  return (
    <section aria-label={t('Unpublished candidate preview')}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert role="alert" type="warning" showIcon banner message={banner} description={`${t('Run ID')}: ${runId}`} />
        <Typography.Text strong>
          {familyActions.length} {t('read-only family-action projections · 0 operational actions created')}
        </Typography.Text>
        {selectedFamilyAction ? (
          <Card title={t('Candidate family decision')} size="small">
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label={t('Target listing')}>
                {text(selectedFamilyAction.targetCompanyProductId)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Primary action pane')}>
                {t(text(selectedFamilyAction.primaryActionPane))}
              </Descriptions.Item>
              <Descriptions.Item label={t('Replenishment decision')}>
                {t(text(selectedFamilyAction.replenishmentEligibility))} ·{' '}
                {t(text(selectedFamilyAction.replenishmentBlockReasonCode))}
              </Descriptions.Item>
              <Descriptions.Item label={t('Actionability')}>
                {selectedFamilyAction.newReplenishmentActionable ? t('candidate actionable') : t('candidate blocked')}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        ) : null}
        <fieldset>
          <legend>{t('Non-action listing performance filters')}</legend>
          <Space wrap>
            {REVIEW_CATEGORIES.map((category) => (
              <label key={category}>
                <input
                  type="checkbox"
                  aria-label={category}
                  checked={selectedCategories.includes(category)}
                  onChange={(event) =>
                    setSelectedCategories((current) =>
                      event.target.checked
                        ? [...current, category].sort()
                        : current.filter((item) => item !== category),
                    )
                  }
                />{' '}
                {t(category)}
              </label>
            ))}
          </Space>
        </fieldset>
        <Typography.Text aria-live="polite">
          {filteredRows.length} {t('listing rows')}
        </Typography.Text>
        <Space wrap aria-label={t('Candidate listing evidence')}>
          {filteredRows.map((row) => {
            const key = text(row.companyProductId ?? row.naturalKey);
            return (
              <button type="button" key={key} onClick={() => setSelectedKey(key)} aria-pressed={row === selectedRow}>
                {text(row.asin)} · {text(row.sku)} · {t('Baseline')} {text(row.baselineTier)} ·{' '}
                {t(text(row.inventoryDisposition))} · {t(text(row.replenishmentEligibility))}
              </button>
            );
          })}
        </Space>
        {selectedEvidence ? <CorrectedInventoryEvidencePanel row={selectedEvidence} t={t} /> : null}
      </Space>
    </section>
  );
}
