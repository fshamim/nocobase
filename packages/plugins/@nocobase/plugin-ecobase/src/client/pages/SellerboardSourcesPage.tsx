import { useAPIClient, useRequest } from '@nocobase/client';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import React from 'react';
import { useT } from '../locale';

type SellerboardReportCategory = 'profit_dashboard' | 'stock_daily' | 'profit_by_product_daily';

type SellerboardReportUrl = {
  name: string;
  category: SellerboardReportCategory;
  url: string;
};

type SellerboardSourceRow = {
  sourceConnectionId: string;
  name: string;
  companyName: string | null;
  timezone: string | null;
  active: boolean;
  freshnessSlaMinutes: number | null;
  reportUrls: SellerboardReportUrl[];
  schedule: {
    enabled: boolean;
    dailyRefreshTime: string;
    refreshIntervalMinutes: number;
    retryIntervalMinutes: number;
  };
  latestRunStatus: string | null;
  latestRunAt: string | null;
  latestRunRowCount: number;
  latestRunNormalizedCount: number;
  latestRunErrorCount: number;
};

type ListResponse = SellerboardSourceRow[] | { data?: SellerboardSourceRow[] | { data?: SellerboardSourceRow[] } };

type SellerboardSourceForm = {
  sourceConnectionId?: string;
  name: string;
  companyName: string;
  timezone: string;
  active: boolean;
  scheduleEnabled: boolean;
  dailyRefreshTime: string;
  refreshIntervalMinutes: number;
  retryIntervalMinutes: number;
  freshnessSlaMinutes: number;
  reportUrls: SellerboardReportUrl[];
};

const defaultReportUrls: SellerboardReportUrl[] = [
  { name: 'Profit Dashboard Data', category: 'profit_dashboard', url: '' },
  { name: 'Stock Daily Data', category: 'stock_daily', url: '' },
  { name: 'Profit by Product Dashboard Daily Data', category: 'profit_by_product_daily', url: '' },
];

function getRows(response: ListResponse | undefined): SellerboardSourceRow[] {
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

function statusColor(status: string | null) {
  if (status === 'success') {
    return 'green';
  }
  if (status === 'partial' || status === 'skipped') {
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

function sourceToForm(row: SellerboardSourceRow): SellerboardSourceForm {
  return {
    sourceConnectionId: row.sourceConnectionId,
    name: row.name,
    companyName: row.companyName ?? '',
    timezone: row.timezone ?? 'Asia/Karachi',
    active: row.active,
    scheduleEnabled: row.schedule.enabled,
    dailyRefreshTime: row.schedule.dailyRefreshTime,
    refreshIntervalMinutes: row.schedule.refreshIntervalMinutes,
    retryIntervalMinutes: row.schedule.retryIntervalMinutes,
    freshnessSlaMinutes: row.freshnessSlaMinutes ?? 1440,
    reportUrls: row.reportUrls.length > 0 ? row.reportUrls : defaultReportUrls,
  };
}

export default function SellerboardSourcesPage() {
  const t = useT();
  const api = useAPIClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<SellerboardSourceForm>();
  const { data, loading, error, refreshAsync } = useRequest<ListResponse>({
    url: 'ecobaseImport:listSellerboardSources',
    method: 'get',
  });
  const rows = getRows(data);

  const resetForm = () => {
    form.resetFields();
    form.setFieldsValue({
      timezone: 'Asia/Karachi',
      active: true,
      scheduleEnabled: true,
      dailyRefreshTime: '00:00',
      refreshIntervalMinutes: 1440,
      retryIntervalMinutes: 60,
      freshnessSlaMinutes: 1440,
      reportUrls: defaultReportUrls,
    });
  };

  const saveSource = async (values: SellerboardSourceForm) => {
    const reportUrls = (values.reportUrls ?? []).filter((entry) => entry?.url?.trim());
    await api.request({
      url: 'ecobaseImport:saveSellerboardSource',
      method: 'post',
      data: { ...values, reportUrls },
    });
    message.success(t('Sellerboard source saved'));
    resetForm();
    await refreshAsync();
  };

  const runNow = async (sourceConnectionId: string) => {
    const sourceVersion = new Date().toISOString();
    await api.request({
      url: 'ecobaseImport:forceRefresh',
      method: 'post',
      data: {
        sourceConnectionId,
        sourceVersion,
        idempotencyKey: `${sourceConnectionId}:sellerboard-force-refresh:${sourceVersion}`,
      },
    });
    message.success(t('Sellerboard import finished'));
    await refreshAsync();
  };

  const deleteSource = async (sourceConnectionId: string) => {
    await api.request({
      url: 'ecobaseImport:deleteSellerboardSource',
      method: 'post',
      data: { sourceConnectionId },
    });
    message.success(t('Sellerboard source deleted'));
    await refreshAsync();
  };

  const columns = [
    {
      title: t('Source'),
      dataIndex: 'name',
      key: 'name',
      render: (value: string, row: SellerboardSourceRow) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{value}</Typography.Text>
          <Typography.Text type="secondary">{row.companyName ?? t('No company')}</Typography.Text>
          <Typography.Text type="secondary">{row.sourceConnectionId}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Reports'),
      dataIndex: 'reportUrls',
      key: 'reportUrls',
      render: (reportUrls: SellerboardReportUrl[]) => <Tag>{reportUrls.length}</Tag>,
    },
    {
      title: t('Schedule'),
      dataIndex: 'schedule',
      key: 'schedule',
      render: (schedule: SellerboardSourceRow['schedule']) => (
        <Space direction="vertical" size={0}>
          <Tag color={schedule.enabled ? 'green' : 'default'}>{schedule.enabled ? t('Enabled') : t('Disabled')}</Tag>
          <Typography.Text type="secondary">{t('Refresh every {{minutes}} minutes', { minutes: schedule.refreshIntervalMinutes })}</Typography.Text>
          <Typography.Text type="secondary">{t('Daily floor {{time}} UTC', { time: schedule.dailyRefreshTime })}</Typography.Text>
          <Typography.Text type="secondary">{t('Retry failures every {{minutes}} minutes', { minutes: schedule.retryIntervalMinutes })}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Latest import'),
      dataIndex: 'latestRunStatus',
      key: 'latestRunStatus',
      render: (_: unknown, row: SellerboardSourceRow) => (
        <Space direction="vertical" size={0}>
          <Tag color={statusColor(row.latestRunStatus)}>{row.latestRunStatus ?? t('No runs')}</Tag>
          <Typography.Text type="secondary">{row.latestRunAt ?? t('Never')}</Typography.Text>
          <Typography.Text type="secondary">
            {t('{{rows}} rows / {{normalized}} normalized / {{errors}} errors', {
              rows: row.latestRunRowCount,
              normalized: row.latestRunNormalizedCount,
              errors: row.latestRunErrorCount,
            })}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Active'),
      dataIndex: 'active',
      key: 'active',
      render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? t('Active') : t('Inactive')}</Tag>,
    },
    {
      title: t('Actions'),
      key: 'actions',
      render: (_: unknown, row: SellerboardSourceRow) => (
        <Space>
          <Button size="small" onClick={() => form.setFieldsValue(sourceToForm(row))}>
            {t('Edit')}
          </Button>
          <Button size="small" type="primary" onClick={() => runNow(row.sourceConnectionId)}>
            {t('Run now')}
          </Button>
          <Popconfirm title={t('Delete this Sellerboard source?')} onConfirm={() => deleteSource(row.sourceConnectionId)}>
            <Button size="small" danger>
              {t('Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title={t('Sellerboard live sources')}>
        <Typography.Paragraph>
          {t(
            'Add the Sellerboard automation report CSV URLs for one company here. Scheduled imports use these live URLs; Run now fetches immediately.',
          )}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={t('Failed to load Sellerboard sources')} style={{ marginBottom: 16 }} /> : null}
        <Table columns={columns} dataSource={rows} loading={loading} rowKey="sourceConnectionId" />
      </Card>

      <Card title={t('Add or edit Sellerboard source')}>
        <Form<SellerboardSourceForm>
          form={form}
          layout="vertical"
          initialValues={{
            timezone: 'Asia/Karachi',
            active: true,
            scheduleEnabled: true,
            dailyRefreshTime: '00:00',
            refreshIntervalMinutes: 1440,
            retryIntervalMinutes: 60,
            freshnessSlaMinutes: 1440,
            reportUrls: defaultReportUrls,
          }}
          onFinish={saveSource}
        >
          <Form.Item name="sourceConnectionId" hidden>
            <Input />
          </Form.Item>
          <Space style={{ width: '100%' }} align="start" size="large">
            <Form.Item name="name" label={t('Source name')} rules={[{ required: true }]}>
              <Input placeholder={t('Sellerboard - Company name')} />
            </Form.Item>
            <Form.Item name="companyName" label={t('Company name')} rules={[{ required: true }]}>
              <Input placeholder={t('Company shown in reports')} />
            </Form.Item>
            <Form.Item name="timezone" label={t('Timezone')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} align="start" size="large">
            <Form.Item name="scheduleEnabled" label={t('Scheduled import')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="dailyRefreshTime" label={t('Daily floor time UTC')} rules={[{ required: true }]}>
              <Input placeholder="00:00" />
            </Form.Item>
            <Form.Item name="refreshIntervalMinutes" label={t('Refresh interval minutes')} rules={[{ required: true }]}>
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item name="retryIntervalMinutes" label={t('Failed-run retry minutes')} rules={[{ required: true }]}>
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item name="freshnessSlaMinutes" label={t('Freshness SLA minutes')} rules={[{ required: true }]}>
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item name="active" label={t('Active')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>

          <Form.List name="reportUrls">
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: '100%' }}>
                {fields.map((field) => (
                  <Space key={field.key} style={{ width: '100%' }} align="start">
                    <Form.Item
                      {...field}
                      name={[field.name, 'name']}
                      label={t('Report name')}
                      rules={[{ required: true }]}
                    >
                      <Input style={{ width: 260 }} />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'category']}
                      label={t('Category')}
                      rules={[{ required: true }]}
                    >
                      <Select
                        style={{ width: 230 }}
                        options={[
                          { value: 'profit_dashboard', label: t('Profit dashboard') },
                          { value: 'stock_daily', label: t('Stock daily') },
                          { value: 'profit_by_product_daily', label: t('Profit by product daily') },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item {...field} name={[field.name, 'url']} label={t('CSV URL')} rules={[{ required: true }]}>
                      <Input style={{ width: 520 }} placeholder="https://app.sellerboard.com/..." />
                    </Form.Item>
                    <Button danger onClick={() => remove(field.name)}>
                      {t('Remove')}
                    </Button>
                  </Space>
                ))}
                <Button onClick={() => add({ name: '', category: 'profit_dashboard', url: '' })}>
                  {t('Add report URL')}
                </Button>
              </Space>
            )}
          </Form.List>

          <Space style={{ marginTop: 24 }}>
            <Button type="primary" htmlType="submit">
              {t('Save source')}
            </Button>
            <Button onClick={resetForm}>{t('New source')}</Button>
          </Space>
        </Form>
      </Card>
    </Space>
  );
}
