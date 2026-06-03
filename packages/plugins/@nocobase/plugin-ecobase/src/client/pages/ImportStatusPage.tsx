import { useRequest } from '@nocobase/client';
import { Alert, Card, Space, Table, Tag, Typography } from 'antd';
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

interface StatusResponse {
  data?: SourceStatusRow[] | { data?: SourceStatusRow[] };
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

function getStatusColor(status: string | null) {
  if (status === 'success') {
    return 'green';
  }
  if (status === 'partial') {
    return 'gold';
  }
  if (status === 'failed') {
    return 'red';
  }
  if (status === 'pending') {
    return 'blue';
  }
  return 'default';
}

export default function ImportStatusPage() {
  const t = useT();
  const { data, loading, error } = useRequest<StatusResponse | SourceStatusRow[]>({
    url: 'ecobaseImport:status',
    method: 'get',
  });
  const rows = getStatusRows(data);

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

  return (
    <Card title={t('Ecobase import/source status')}>
      {error ? <Alert type="error" message={t('Failed to load import status')} style={{ marginBottom: 16 }} /> : null}
      <Table columns={columns} dataSource={rows} loading={loading} rowKey="sourceConnectionId" />
    </Card>
  );
}
