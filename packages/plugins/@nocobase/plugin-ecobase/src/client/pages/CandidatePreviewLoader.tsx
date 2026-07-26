/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Input, Space, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../locale';
import {
  CandidatePreviewPanel,
  type CorrectedFamilyActionEvidenceRow,
  type CorrectedInventoryEvidenceRow,
} from './CorrectedInventoryEvidence';

type PlainRecord = Record<string, unknown>;

export const UNPUBLISHED_CANDIDATE_BANNER = 'UNPUBLISHED CANDIDATE — NOT OPERATIONAL';

function unwrapData(response: unknown): PlainRecord {
  let data = response;
  for (let index = 0; index < 5; index += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) break;
    data = (data as PlainRecord).data;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as PlainRecord) : {};
}

function validatedCandidatePreview(response: unknown, requestedRunId: string): PlainRecord {
  const preview = unwrapData(response);
  if (
    preview.runId !== requestedRunId ||
    preview.banner !== UNPUBLISHED_CANDIDATE_BANNER ||
    !Array.isArray(preview.rows) ||
    !Array.isArray(preview.familyActions)
  ) {
    throw new Error('Candidate preview response did not match the requested verified run contract.');
  }
  return preview;
}

function listingRows(value: unknown): CorrectedInventoryEvidenceRow[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is CorrectedInventoryEvidenceRow =>
          Boolean(row) &&
          typeof row === 'object' &&
          !Array.isArray(row) &&
          typeof (row as PlainRecord).companyProductId === 'string',
      )
    : [];
}

function familyActions(value: unknown): CorrectedFamilyActionEvidenceRow[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is CorrectedFamilyActionEvidenceRow =>
          Boolean(row) &&
          typeof row === 'object' &&
          !Array.isArray(row) &&
          typeof (row as PlainRecord).companyProductFamilyId === 'string',
      )
    : [];
}

export function CandidatePreviewLoader({
  initialRunId,
  autoLoad = false,
  readOnly = false,
}: {
  initialRunId: string;
  autoLoad?: boolean;
  readOnly?: boolean;
}) {
  const t = useT();
  const api = useAPIClient();
  const [runId, setRunId] = useState(initialRunId);
  const [candidatePreview, setCandidatePreview] = useState<PlainRecord>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const autoLoadedRunId = useRef('');

  useEffect(() => {
    setRunId(initialRunId);
    setCandidatePreview({});
  }, [initialRunId]);

  const load = useCallback(
    async (requestedRunId: string) => {
      const explicitRunId = requestedRunId.trim();
      if (!explicitRunId) return;
      setLoading(true);
      setError(null);
      try {
        const response = await api.request({
          url: 'ecobaseInventoryPlanning:candidatePreview',
          method: 'post',
          data: { runId: explicitRunId },
        });
        setCandidatePreview(validatedCandidatePreview(response, explicitRunId));
      } catch (cause) {
        setCandidatePreview({});
        setError(cause instanceof Error ? cause : new Error(t('Candidate preview failed.')));
      } finally {
        setLoading(false);
      }
    },
    [api, t],
  );

  useEffect(() => {
    const explicitRunId = initialRunId.trim();
    if (!autoLoad || !explicitRunId || autoLoadedRunId.current === explicitRunId) return;
    autoLoadedRunId.current = explicitRunId;
    void load(explicitRunId);
  }, [autoLoad, initialRunId, load]);

  const rows = listingRows(candidatePreview.rows);
  const actions = familyActions(candidatePreview.familyActions);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {readOnly ? (
        <Typography.Text>
          {t('Run ID')}: <Typography.Text code>{initialRunId}</Typography.Text>
        </Typography.Text>
      ) : (
        <>
          <Typography.Text strong>{t('Explicit verified run ID')}</Typography.Text>
          <Input
            aria-label={t('Explicit verified run ID')}
            value={runId}
            onChange={(event) => {
              setRunId(event.target.value);
              setCandidatePreview({});
            }}
          />
          <Button loading={loading} disabled={!runId.trim()} onClick={() => void load(runId)}>
            {t('Load read-only candidate preview')}
          </Button>
        </>
      )}
      {readOnly && loading ? <Spin aria-label={t('Loading candidate preview')} /> : null}
      {error ? <Alert role="alert" type="error" showIcon message={error.message} /> : null}
      {Array.isArray(candidatePreview.rows) ? (
        <CandidatePreviewPanel
          runId={initialRunId.trim() || runId.trim()}
          banner={String(candidatePreview.banner)}
          rows={rows}
          familyActions={actions}
          t={t}
        />
      ) : null}
    </Space>
  );
}
