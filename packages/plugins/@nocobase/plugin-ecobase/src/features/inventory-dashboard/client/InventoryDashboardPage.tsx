/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Inventory Dashboard page shell (AD-5, read-only Phase 2). Composes the KPI
 * header and eleven config-driven pane sections. Run pinning per AD-3: the
 * header's publishedRunId is passed on every pane request; a runSuperseded
 * response freezes panes and surfaces a refresh notice — runs are never mixed.
 */

import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Input, Select, Space, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardHeader as DashboardHeaderData, DashboardRow, PaneKey, PaneResult } from '../server/contract';
import { useT } from '../../../client/locale';
import DashboardHeaderStrip from './DashboardHeader';
import { isDashboardHeaderPayload, isPaneResultPayload, unwrapEnvelope } from './envelope';
import PaneSection, {
  defaultObserveVisibility,
  type ObserveVisibility,
  type PaneFetchRequest,
  type PaneSectionHandle,
} from './PaneSection';
import { PANE_CONFIGS } from './pane-configs';
import { TEXT } from './dashboard-text';
import { DASHBOARD_TOKENS } from './dashboard-tokens';

const SEARCH_DEBOUNCE_MS = 300;

interface EcobaseRequestClient {
  request: (options: { url: string; method: 'post'; data: Record<string, unknown> }) => Promise<unknown>;
}

export interface InventoryDashboardPageProps {
  observeVisibility?: ObserveVisibility;
}

const InventoryDashboardPage: React.FC<InventoryDashboardPageProps> = ({
  observeVisibility = defaultObserveVisibility,
}) => {
  const t = useT();
  // Stable reference for async callbacks: `t` may change identity per render
  // (i18n re-binds); depending on it from the fetch callbacks would refire the
  // header effect on every render and, in the error path, loop forever.
  const tRef = useRef(t);
  tRef.current = t;
  const api = useAPIClient() as unknown as EcobaseRequestClient;
  const [header, setHeader] = useState<DashboardHeaderData | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | undefined>(undefined);
  const [companyOptions, setCompanyOptions] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [supersededBy, setSupersededBy] = useState<string | null>(null);
  const paneRefs = useRef(new Map<PaneKey, PaneSectionHandle | null>());

  const loadHeader = useCallback(async () => {
    setHeaderError(null);
    try {
      const data = unwrapEnvelope(
        await api.request({ url: 'ecobaseInventoryDashboard:header', method: 'post', data: { companyId } }),
      );
      if (!isDashboardHeaderPayload(data)) {
        throw new Error(tRef.current(TEXT.unexpectedResponse));
      }
      setHeader(data);
      setSupersededBy(null);
    } catch (error) {
      setHeaderError(error instanceof Error ? error.message : String(error));
    }
  }, [api, companyId]);

  useEffect(() => {
    loadHeader();
  }, [loadHeader]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fetchPane = useCallback(
    async (request: PaneFetchRequest): Promise<PaneResult> => {
      const data = unwrapEnvelope(
        await api.request({ url: 'ecobaseInventoryDashboard:pane', method: 'post', data: { ...request } }),
      );
      if (!isPaneResultPayload(data)) {
        throw new Error(tRef.current(TEXT.unexpectedResponse));
      }
      return data;
    },
    [api],
  );

  const onSuperseded = useCallback((publishedRunId: string) => {
    setSupersededBy(publishedRunId);
  }, []);

  const onRowsLoaded = useCallback((rows: DashboardRow[]) => {
    setCompanyOptions((existing) => {
      const merged = new Set(existing);
      for (const row of rows ?? []) if (row?.identity?.company) merged.add(row.identity.company);
      return merged.size === existing.length ? existing : [...merged].sort();
    });
  }, []);

  const onTileClick = useCallback((pane: PaneKey) => {
    paneRefs.current.get(pane)?.focusAndLoad();
  }, []);

  const companySelectOptions = useMemo(
    () => companyOptions.map((company) => ({ label: company, value: company })),
    [companyOptions],
  );

  const runId = header?.publishedRunId ?? '';
  const frozen = supersededBy !== null;

  return (
    <div>
      <Space
        align="center"
        wrap
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: DASHBOARD_TOKENS.sectionGap }}
      >
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            {t(TEXT.pageTitle)}
          </Typography.Title>
          {header ? (
            <Typography.Text type="secondary">{`${t(TEXT.publishedRun)}: ${header.publishedRunId}`}</Typography.Text>
          ) : null}
        </div>
        <Space wrap>
          <Select
            allowClear
            placeholder={t(TEXT.allCompanies)}
            aria-label={t(TEXT.companyFilterLabel)}
            style={{ minWidth: 180 }}
            options={companySelectOptions}
            value={companyId}
            onChange={(value: string | undefined) => setCompanyId(value ?? undefined)}
          />
          <Input.Search
            allowClear
            placeholder={t(TEXT.searchPlaceholder)}
            aria-label={t(TEXT.searchLabel)}
            style={{ width: 260 }}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </Space>
      </Space>

      {frozen ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: DASHBOARD_TOKENS.sectionGap }}
          message={t(TEXT.runSupersededNotice)}
          action={
            <Button size="small" onClick={() => loadHeader()}>
              {t(TEXT.refresh)}
            </Button>
          }
        />
      ) : null}

      {headerError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: DASHBOARD_TOKENS.sectionGap }}
          message={`${t(TEXT.loadFailed)}: ${headerError}`}
          action={
            <Button size="small" onClick={() => loadHeader()}>
              {t(TEXT.retry)}
            </Button>
          }
        />
      ) : header ? (
        <DashboardHeaderStrip header={header} onTileClick={onTileClick} t={t} />
      ) : (
        <Spin aria-label={`${t(TEXT.pageTitle)} ${t(TEXT.loading)}`} />
      )}

      {runId
        ? PANE_CONFIGS.map((config) => (
            <PaneSection
              key={`${config.pane}:${runId}`}
              ref={(handle) => {
                paneRefs.current.set(config.pane, handle);
              }}
              config={config}
              runId={runId}
              companyId={companyId}
              search={search}
              frozen={frozen}
              fetchPane={fetchPane}
              onSuperseded={onSuperseded}
              onRowsLoaded={onRowsLoaded}
              observeVisibility={observeVisibility}
              t={t}
            />
          ))
        : null}
    </div>
  );
};

export default InventoryDashboardPage;
