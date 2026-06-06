import { useAPIClient } from '@nocobase/client';
import { App, Button, Card, Collapse, Descriptions, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import React, { useEffect, useState } from 'react';
import { useT } from '../locale';

interface CollectionSummary {
  collectionName: string;
  title: string;
  domain: string;
  access: string;
  readOnly: boolean;
  rowCount: number;
  freshnessStatus: string;
  warningCount: number;
  companyScoped: boolean;
  sourceScoped: boolean;
  starterViewKeys: string[];
}

interface DomainSummary {
  key: string;
  title: string;
  collections: CollectionSummary[];
}

interface BusinessView {
  key: string;
  title: string;
  domain: string;
  collectionName: string;
  description: string;
  filters: Record<string, unknown>;
  sort: string[];
  columns: string[];
  groupBy?: string[];
  readOnly: boolean;
}

interface WorkspaceData {
  domains?: DomainSummary[];
  starterViews?: BusinessView[];
  savedViews?: BusinessView[];
  permissionModel?: Record<string, string>;
  scopeRequired?: boolean;
  scopeMessage?: string | null;
}

interface WorkspaceResponse extends WorkspaceData {
  data?: WorkspaceData & { data?: WorkspaceData };
}

interface PreviewData {
  collectionName: string;
  viewKey?: string | null;
  readOnly: boolean;
  rowCount: number;
  columns: string[];
  rows: Record<string, unknown>[];
  groupBy?: string[];
  groupedRows?: { key: Record<string, unknown>; rowCount: number }[];
}

function unwrapWorkspace(response: WorkspaceResponse | undefined): WorkspaceData {
  return response?.data?.data ?? response?.data ?? response ?? {};
}

function unwrapPreview(response: unknown): PreviewData | null {
  const first = (response as { data?: unknown })?.data ?? response;
  const second = (first as { data?: unknown })?.data ?? first;
  return ((second as { data?: unknown })?.data ?? second ?? null) as PreviewData | null;
}

function parseCsvList(value: unknown) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFilters(value: unknown) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(value));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (error) {
    throw new Error('Filters must be valid JSON.');
  }
}

function accessColor(access: string) {
  if (access === 'read_only_audit') {
    return 'blue';
  }
  if (access === 'operator_editable') {
    return 'green';
  }
  if (access === 'configuration') {
    return 'gold';
  }
  return 'default';
}

export default function CollectionsWorkspacePage() {
  const t = useT();
  const api = useAPIClient();
  const { message } = App.useApp();
  const [company, setCompany] = useState('');
  const [sourceConnectionId, setSourceConnectionId] = useState('');
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form] = Form.useForm();
  const loadWorkspace = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseOperatorWorkspace:workspace',
        method: 'post',
        data: { company: company || undefined, sourceConnectionId: sourceConnectionId || undefined },
      });
      setData(response?.data ?? response);
    } catch (workspaceError) {
      setError(workspaceError);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, [company, sourceConnectionId]);

  const refresh = loadWorkspace;
  const workspace = unwrapWorkspace(data ?? undefined);

  const openPreview = async (values: { viewKey?: string; collectionName?: string }) => {
    const response = await api.request({
      url: 'ecobaseOperatorWorkspace:preview',
      method: 'post',
      data: { ...values, filters: { company: company || undefined, sourceConnectionId: sourceConnectionId || undefined } },
    });
    setPreview(unwrapPreview(response));
  };

  const saveBusinessView = async (values: Record<string, unknown>) => {
    const columns = parseCsvList(values.columns);
    const sort = parseCsvList(values.sort);
    const groupBy = parseCsvList(values.groupBy);
    const filters = parseFilters(values.filters);
    await api.request({
      url: 'ecobaseOperatorWorkspace:saveView',
      method: 'post',
      data: { ...values, columns, sort, groupBy, filters },
    });
    message.success(t('Business view saved'));
    setSaveViewOpen(false);
    form.resetFields();
    await refresh();
  };

  const collectionColumns = [
    { title: t('Collection'), dataIndex: 'title', key: 'title' },
    { title: t('Rows'), dataIndex: 'rowCount', key: 'rowCount' },
    {
      title: t('Access'),
      dataIndex: 'access',
      key: 'access',
      render: (value: string) => <Tag color={accessColor(value)}>{value}</Tag>,
    },
    { title: t('Freshness'), dataIndex: 'freshnessStatus', key: 'freshnessStatus' },
    { title: t('Warnings'), dataIndex: 'warningCount', key: 'warningCount' },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: unknown, row: CollectionSummary) => (
        <Button onClick={() => openPreview({ collectionName: row.collectionName })}>{t('Open table preview')}</Button>
      ),
    },
  ];

  const viewColumns = [
    { title: t('View'), dataIndex: 'title', key: 'title' },
    { title: t('Collection'), dataIndex: 'collectionName', key: 'collectionName' },
    { title: t('Description'), dataIndex: 'description', key: 'description' },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: unknown, row: BusinessView) => <Button onClick={() => openPreview({ viewKey: row.key })}>{t('Open view')}</Button>,
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3}>{t('Ecobase collections workspace')}</Typography.Title>
      <Card>
        <Space wrap>
          <Input placeholder={t('Company scope')} value={company} onChange={(event) => setCompany(event.target.value)} />
          <Input
            placeholder={t('Source connection scope')}
            value={sourceConnectionId}
            onChange={(event) => setSourceConnectionId(event.target.value)}
          />
          <Button onClick={() => refresh()}>{t('Apply scope')}</Button>
          <Button type="primary" onClick={() => setSaveViewOpen(true)}>{t('Save business view')}</Button>
        </Space>
      </Card>
      {workspace.scopeRequired ? (
        <Card>
          <Typography.Text type="warning">{workspace.scopeMessage ?? t('Select a company or source connection before opening rows.')}</Typography.Text>
        </Card>
      ) : null}
      {error ? <Card><Typography.Text type="danger">{String(error)}</Typography.Text></Card> : null}
      <Card title={t('Permission model')}>
        <Descriptions column={1}>
          {Object.entries(workspace.permissionModel ?? {}).map(([key, value]) => (
            <Descriptions.Item key={key} label={key}>{value}</Descriptions.Item>
          ))}
        </Descriptions>
      </Card>
      <Collapse
        items={(workspace.domains ?? []).map((domain) => ({
          key: domain.key,
          label: `${domain.title} (${domain.collections.length})`,
          children: <Table loading={loading} rowKey="collectionName" columns={collectionColumns} dataSource={domain.collections} pagination={false} />,
        }))}
      />
      <Card title={t('Suggested starter views')}>
        <Table rowKey="key" columns={viewColumns} dataSource={workspace.starterViews ?? []} pagination={false} />
      </Card>
      <Card title={t('Saved business views')}>
        <Table rowKey="key" columns={viewColumns} dataSource={workspace.savedViews ?? []} pagination={false} />
      </Card>
      <Modal title={t('Table preview')} open={Boolean(preview)} onCancel={() => setPreview(null)} footer={null} width={1000}>
        <Typography.Text type="secondary">
          {preview?.collectionName} · {preview?.rowCount ?? 0} {t('rows')} · {preview?.readOnly ? t('read-only audit') : t('operator view')}
        </Typography.Text>
        {preview?.groupedRows?.length ? (
          <Table
            rowKey={(row) => JSON.stringify(row.key)}
            dataSource={preview.groupedRows}
            columns={[
              { title: String(t('Group')), dataIndex: 'key', key: 'key', render: (value: Record<string, unknown>) => JSON.stringify(value) },
              { title: String(t('Rows')), dataIndex: 'rowCount', key: 'rowCount' },
            ]}
            pagination={false}
          />
        ) : null}
        <Table
          rowKey={(row, index) => String(row.id ?? row.naturalKey ?? index)}
          dataSource={preview?.rows ?? []}
          columns={(preview?.columns ?? []).slice(0, 8).map((column) => ({
            title: column,
            dataIndex: column,
            key: column,
            render: (value: unknown) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '')),
          }))}
          scroll={{ x: true }}
        />
      </Modal>
      <Modal title={t('Save business view')} open={saveViewOpen} onCancel={() => setSaveViewOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={saveBusinessView}>
          <Form.Item name="title" label={t('Title')} rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="collectionName" label={t('Collection name')} rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label={t('Description')}><Input /></Form.Item>
          <Form.Item name="filters" label={t('Filters JSON')}><Input.TextArea placeholder='{"status":"open"}' /></Form.Item>
          <Form.Item name="sort" label={t('Sort fields, comma-separated')}><Input placeholder="company,-openedAt" /></Form.Item>
          <Form.Item name="columns" label={t('Columns, comma-separated')}><Input /></Form.Item>
          <Form.Item name="groupBy" label={t('Group fields, comma-separated')}><Input placeholder="company,severity" /></Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
