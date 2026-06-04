import { useAPIClient, useRequest } from '@nocobase/client';
import { Alert, App, Button, Card, Space, Table, Tag, Typography } from 'antd';
import React from 'react';
import { useT } from '../locale';

interface SourceStatusRow {
  sourceConnectionId: string;
  connectionName: string;
  sourceType: string;
  domain: string;
  active: boolean;
  latestImportRunId: string | null;
  latestRunStatus: string | null;
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  errorCount: number;
  lastRunAt: string | null;
}

interface PlanningProductListingRow {
  planningProductListingId: string;
  rawListingNaturalKey: string;
  sku?: string;
  title?: string;
  sourceConnectionId: string;
  mappingMode: string;
  mappingStatus: string;
  mappedAt?: string;
}

interface DuplicateMappingRow {
  planningProductId: string;
  naturalKey: string;
  company: string;
  canonicalAsin: string;
  title?: string;
  mappingStatus: string;
  listingCount: number;
  listings: PlanningProductListingRow[];
}

interface StatusResponse {
  data?: SourceStatusRow[] | { data?: SourceStatusRow[] };
}

interface DuplicateMappingsResponse {
  data?: DuplicateMappingRow[] | { data?: DuplicateMappingRow[] };
}

interface PlanningValidationRow {
  key: string;
  label: string;
  status: 'pass' | 'fail';
  expected: unknown;
  actual: unknown;
  evidence: Record<string, unknown>;
}

interface PlanningValidationReport {
  status?: 'pass' | 'fail';
  rows?: PlanningValidationRow[];
}

interface PlanningValidationResponse extends PlanningValidationReport {
  data?: PlanningValidationReport & { data?: PlanningValidationReport };
}

function getStatusRows(response: StatusResponse | SourceStatusRow[] | undefined): SourceStatusRow[] {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.data?.data)) {
    return response.data.data;
  }
  return [];
}

function getDuplicateMappingRows(response: DuplicateMappingsResponse | DuplicateMappingRow[] | undefined) {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.data?.data)) {
    return response.data.data;
  }
  return [];
}

function getPlanningValidationRows(response: PlanningValidationResponse | undefined): PlanningValidationRow[] {
  if (Array.isArray(response?.rows)) {
    return response.rows;
  }
  if (Array.isArray(response?.data?.rows)) {
    return response.data.rows;
  }
  if (Array.isArray(response?.data?.data?.rows)) {
    return response.data.data.rows;
  }
  return [];
}

function getStatusColor(status: string | null) {
  if (status === 'success' || status === 'confirmed' || status === 'auto_mapped' || status === 'pass') {
    return 'green';
  }
  if (status === 'partial' || status === 'needs_review' || status === 'adjusted') {
    return 'gold';
  }
  if (status === 'failed' || status === 'fail') {
    return 'red';
  }
  if (status === 'pending') {
    return 'blue';
  }
  return 'default';
}

export default function ImportStatusPage() {
  const t = useT();
  const api = useAPIClient();
  const { message } = App.useApp();
  const { data, loading, error } = useRequest<StatusResponse | SourceStatusRow[]>({
    url: 'ecobaseImport:status',
    method: 'get',
  });
  const {
    data: duplicateMappingData,
    loading: duplicateMappingsLoading,
    error: duplicateMappingsError,
    refreshAsync: refreshDuplicateMappings,
  } = useRequest<DuplicateMappingsResponse | DuplicateMappingRow[]>({
    url: 'ecobasePlanning:listDuplicateMappings',
    method: 'get',
  });
  const {
    data: planningValidationData,
    loading: planningValidationLoading,
    error: planningValidationError,
  } = useRequest<PlanningValidationResponse>({
    url: 'ecobasePlanning:validationReport',
    method: 'get',
  });
  const rows = getStatusRows(data);
  const duplicateRows = getDuplicateMappingRows(duplicateMappingData);
  const planningValidationRows = getPlanningValidationRows(planningValidationData);

  const confirmMapping = async (planningProductId: string) => {
    await api.request({
      url: 'ecobasePlanning:confirmMapping',
      method: 'post',
      data: { planningProductId },
    });
    message.success(t('Planning product mapping confirmed'));
    await refreshDuplicateMappings();
  };

  const adjustMapping = async (row: DuplicateMappingRow, listing: PlanningProductListingRow) => {
    const targetPlanningProductId = window.prompt(
      t('Target planning product ID. Leave blank to create a manual split for this listing.'),
      row.planningProductId,
    );
    if (targetPlanningProductId === null) {
      return;
    }
    await api.request({
      url: 'ecobasePlanning:adjustMapping',
      method: 'post',
      data: {
        planningProductListingId: listing.planningProductListingId,
        targetPlanningProductId: targetPlanningProductId.trim() || undefined,
        targetCompany: row.company,
        targetCanonicalAsin: row.canonicalAsin,
        targetTitle: listing.title ?? row.title,
        note: 'Adjusted from Ecobase duplicate mapping review.',
      },
    });
    message.success(t('Planning product mapping adjusted'));
    await refreshDuplicateMappings();
  };

  const columns = [
    {
      title: t('Connection'),
      dataIndex: 'connectionName',
      key: 'connectionName',
      render: (value: string, row: SourceStatusRow) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{value}</Typography.Text>
          <Typography.Text type="secondary">{row.sourceConnectionId}</Typography.Text>
        </Space>
      ),
    },
    { title: t('Source type'), dataIndex: 'sourceType', key: 'sourceType' },
    { title: t('Domain'), dataIndex: 'domain', key: 'domain' },
    {
      title: t('Latest status'),
      dataIndex: 'latestRunStatus',
      key: 'latestRunStatus',
      render: (status: string | null) => <Tag color={getStatusColor(status)}>{status ?? t('No runs')}</Tag>,
    },
    { title: t('Rows'), dataIndex: 'rowCount', key: 'rowCount' },
    { title: t('Normalized'), dataIndex: 'normalizedCount', key: 'normalizedCount' },
    { title: t('Warnings'), dataIndex: 'warningCount', key: 'warningCount' },
    { title: t('Errors'), dataIndex: 'errorCount', key: 'errorCount' },
    {
      title: t('Last run time'),
      dataIndex: 'lastRunAt',
      key: 'lastRunAt',
      render: (value: string | null) => value ?? t('Never'),
    },
  ];

  const duplicateColumns = [
    {
      title: t('Planning product'),
      dataIndex: 'canonicalAsin',
      key: 'canonicalAsin',
      render: (value: string, row: DuplicateMappingRow) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{value}</Typography.Text>
          <Typography.Text type="secondary">{row.company}</Typography.Text>
          <Typography.Text type="secondary">{row.planningProductId}</Typography.Text>
        </Space>
      ),
    },
    { title: t('Title'), dataIndex: 'title', key: 'title' },
    { title: t('Listings'), dataIndex: 'listingCount', key: 'listingCount' },
    {
      title: t('Mapping status'),
      dataIndex: 'mappingStatus',
      key: 'mappingStatus',
      render: (status: string) => <Tag color={getStatusColor(status)}>{status}</Tag>,
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: unknown, row: DuplicateMappingRow) => (
        <Button type="primary" size="small" onClick={() => confirmMapping(row.planningProductId)}>
          {t('Confirm mapping')}
        </Button>
      ),
    },
  ];

  const planningValidationColumns = [
    { title: t('Check'), dataIndex: 'label', key: 'label' },
    {
      title: t('Status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: 'pass' | 'fail') => <Tag color={getStatusColor(status)}>{status}</Tag>,
    },
    {
      title: t('Expected'),
      dataIndex: 'expected',
      key: 'expected',
      render: (value: unknown) => String(value),
    },
    {
      title: t('Actual'),
      dataIndex: 'actual',
      key: 'actual',
      render: (value: unknown) => String(value),
    },
    {
      title: t('Evidence'),
      dataIndex: 'evidence',
      key: 'evidence',
      render: (value: Record<string, unknown>) => <Typography.Text code>{JSON.stringify(value)}</Typography.Text>,
    },
  ];

  const listingColumns = (row: DuplicateMappingRow) => [
    { title: t('SKU'), dataIndex: 'sku', key: 'sku' },
    { title: t('Title'), dataIndex: 'title', key: 'title' },
    { title: t('Source connection'), dataIndex: 'sourceConnectionId', key: 'sourceConnectionId' },
    {
      title: t('Mapping status'),
      dataIndex: 'mappingStatus',
      key: 'mappingStatus',
      render: (status: string) => <Tag color={getStatusColor(status)}>{status}</Tag>,
    },
    {
      title: t('Mapping mode'),
      dataIndex: 'mappingMode',
      key: 'mappingMode',
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: unknown, listing: PlanningProductListingRow) => (
        <Button size="small" onClick={() => adjustMapping(row, listing)}>
          {t('Adjust mapping')}
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title={t('Ecobase import/source status')}>
        {error ? <Alert type="error" message={t('Failed to load import status')} style={{ marginBottom: 16 }} /> : null}
        <Table columns={columns} dataSource={rows} loading={loading} rowKey="sourceConnectionId" />
      </Card>
      <Card title={t('Planning calculation validation report')}>
        {planningValidationError ? (
          <Alert type="error" message={t('Failed to load planning validation report')} style={{ marginBottom: 16 }} />
        ) : null}
        <Table
          columns={planningValidationColumns}
          dataSource={planningValidationRows}
          loading={planningValidationLoading}
          rowKey="key"
          pagination={false}
        />
      </Card>
      <Card title={t('Planning product duplicate mapping review')}>
        {duplicateMappingsError ? (
          <Alert type="error" message={t('Failed to load duplicate mapping review')} style={{ marginBottom: 16 }} />
        ) : null}
        <Table
          columns={duplicateColumns}
          dataSource={duplicateRows}
          loading={duplicateMappingsLoading}
          rowKey="planningProductId"
          expandable={{
            expandedRowRender: (row) => (
              <Table
                columns={listingColumns(row)}
                dataSource={row.listings}
                pagination={false}
                rowKey="planningProductListingId"
              />
            ),
          }}
        />
      </Card>
    </Space>
  );
}
