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
  Popover,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import React, { useState } from 'react';
import { useT } from '../locale';

type SellerboardReportCategory = 'profit_dashboard' | 'stock_daily' | 'profit_by_product_daily';

type SellerboardReportUrl = {
  name: string;
  category: SellerboardReportCategory;
  url: string;
};

type SellerboardImportIssue = {
  rowNumber: number | null;
  sourceKey: string | null;
  severity: string | null;
  code: string | null;
  status: string | null;
  message: string | null;
  payloadPreview: Record<string, unknown> | null;
};

type SellerboardImportRunLog = {
  importRunId: string | null;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  sourceIdentifier: string | null;
  sourceVersion: string | null;
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  errorCount: number;
  errorMessage: string | null;
  issues: SellerboardImportIssue[];
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
  latestRunWarningCount: number;
  latestRunErrorCount: number;
  latestRunErrorMessage: string | null;
  latestRunLogs: SellerboardImportRunLog[];
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
  if (status === 'stale') {
    return 'orange';
  }
  return 'default';
}

function statusLabel(status: string | null) {
  if (status === 'success') {
    return 'Success';
  }
  if (status === 'partial') {
    return 'Completed with errors';
  }
  if (status === 'failed') {
    return 'Failed';
  }
  if (status === 'pending') {
    return 'Running';
  }
  if (status === 'skipped') {
    return 'Skipped';
  }
  if (status === 'stale') {
    return 'Stale data';
  }
  return 'No runs';
}

function formatDuration(minutes: number) {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

function shortSourceId(sourceConnectionId: string) {
  return sourceConnectionId.slice(-4);
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('MMM D, YYYY h:mm A') : value;
}

function reportCategoryLabel(value: string | null | undefined) {
  if (value === 'profit_dashboard') {
    return 'Profit dashboard';
  }
  if (value === 'stock_daily') {
    return 'Stock daily';
  }
  if (value === 'profit_by_product_daily') {
    return 'Profit by product daily';
  }
  return value ?? 'Report';
}

function humanSourceKey(sourceKey: string | null) {
  if (!sourceKey) {
    return 'Report';
  }
  const [category, name] = sourceKey.split(':');
  return name ? `${reportCategoryLabel(category)} — ${name}` : reportCategoryLabel(category);
}

function payloadReportName(issue: SellerboardImportIssue) {
  const reportName = issue.payloadPreview?.reportName;
  return typeof reportName === 'string' ? reportName : null;
}

function isFreshnessMessage(issue: Pick<SellerboardImportIssue, 'code' | 'message'>) {
  const message = issue.message ?? '';
  return (
    message.includes('was stale') ||
    message.includes('freshness checks') ||
    (message.includes('expected') && message.includes('got')) ||
    Boolean(issue.code?.includes('stale'))
  );
}

function humanIssueMessage(issue: Pick<SellerboardImportIssue, 'code' | 'message'>) {
  const message = issue.message ?? '';
  if (message.includes('HTTP 401')) {
    return 'Unauthorized report URL. Re-copy the Sellerboard CSV link for this report.';
  }
  if (message.includes('HTTP 404')) {
    return 'Report URL was not found. Check the saved Sellerboard CSV link.';
  }
  if (message.includes('HTTP 429')) {
    return 'Sellerboard rate-limited the request. The scheduler will retry later.';
  }
  if (isFreshnessMessage(issue)) {
    return 'Imported available data. Waiting for Sellerboard to publish the latest daily reports.';
  }
  return message.replace(/^Sellerboard live import failed:\s*/, '') || 'Import issue recorded.';
}

function issueExplanation(issue: Pick<SellerboardImportIssue, 'code' | 'message'>) {
  const message = issue.message ?? '';
  if (message.includes('HTTP 401')) {
    return {
      title: 'Unauthorized report URL',
      body: [
        'Sellerboard rejected one of the saved CSV links, so Ecobase could not read that report.',
        'The most common cause is an expired or copied-from-the-wrong-place report URL.',
        'Fix: open Sellerboard, copy a fresh automation CSV URL for that report, save the source, then run import again.',
      ],
    };
  }
  if (message.includes('HTTP 404')) {
    return {
      title: 'Report URL not found',
      body: [
        'The saved CSV URL no longer points to an available Sellerboard report.',
        'Fix: replace the saved URL with the current Sellerboard automation CSV URL for that report.',
      ],
    };
  }
  if (message.includes('HTTP 429')) {
    return {
      title: 'Sellerboard rate limit',
      body: [
        'Sellerboard temporarily limited requests from this app.',
        'No data was changed for the blocked report. The scheduler can retry after the retry interval.',
      ],
    };
  }
  if (isFreshnessMessage(issue)) {
    return {
      title: 'Why this says stale data',
      body: [
        'The import worked and saved the available CSV data, but one or more daily reports were still one day behind.',
        'For example, if Ecobase runs just after midnight on Jun 9, it expects Jun 8 data. Sellerboard may still only expose Jun 7 until it finishes publishing the daily reports.',
        'This is a freshness warning, not a broken import. Trend data is still deduplicated by report date and listing, so reruns do not create duplicate normalized rows.',
        'Usually this clears on the next run after Sellerboard publishes the latest daily reports. If it happens often, schedule imports later in the morning.',
      ],
    };
  }
  return {
    title: 'Import issue',
    body: [message.replace(/^Sellerboard live import failed:\s*/, '') || 'Ecobase recorded an import issue for this run.'],
  };
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
  const [runningSourceId, setRunningSourceId] = useState<string | null>(null);
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
    const hideLoading = message.loading(t('Sellerboard import is running...'), 0);
    setRunningSourceId(sourceConnectionId);
    try {
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
    } finally {
      hideLoading();
      setRunningSourceId(null);
    }
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

  const renderIssueHelp = (issue: Pick<SellerboardImportIssue, 'code' | 'message'>) => {
    const explanation = issueExplanation(issue);
    return (
      <Popover
        placement="left"
        title={t(explanation.title)}
        content={
          <Space direction="vertical" size="small" style={{ maxWidth: 460 }}>
            {explanation.body.map((line) => (
              <Typography.Paragraph key={line} style={{ marginBottom: 0 }}>
                {t(line)}
              </Typography.Paragraph>
            ))}
          </Space>
        }
        trigger="click"
      >
        <Button size="small" shape="circle" aria-label={t('Explain this import message')}>
          ?
        </Button>
      </Popover>
    );
  };

  const renderImportLogs = (row: SellerboardSourceRow) => {
    const runs = row.latestRunLogs ?? [];
    if (runs.length === 0) {
      return <Typography.Text type="secondary">{t('No import runs have been recorded for this source yet.')}</Typography.Text>;
    }

    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {runs.map((run) => (
          <Card
            key={run.importRunId ?? `${row.sourceConnectionId}-${run.startedAt}`}
            size="small"
            title={
              <Space wrap>
                <Tag color={statusColor(run.status)}>{t(statusLabel(run.status))}</Tag>
                <Typography.Text>{formatTimestamp(run.finishedAt ?? run.startedAt) ?? t('No timestamp')}</Typography.Text>
                <Typography.Text type="secondary">{run.sourceIdentifier ?? t('No source identifier')}</Typography.Text>
              </Space>
            }
          >
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                {t('{{rows}} CSV rows imported, {{normalized}} database records saved, {{warnings}} warnings, {{errors}} errors', {
                  rows: run.rowCount,
                  normalized: run.normalizedCount,
                  warnings: run.warningCount,
                  errors: run.errorCount,
                })}
              </Typography.Text>
              {run.errorMessage ? (
                <Alert
                  type={isFreshnessMessage({ message: run.errorMessage }) ? 'warning' : 'error'}
                  message={humanIssueMessage({ message: run.errorMessage })}
                  action={renderIssueHelp({ message: run.errorMessage })}
                  showIcon
                />
              ) : null}
              {run.issues.length > 0 ? (
                <Table
                  size="small"
                  pagination={false}
                  rowKey={(_, index) => `${run.importRunId}-${index}`}
                  dataSource={run.issues}
                  columns={[
                    {
                      title: t('Severity'),
                      dataIndex: 'severity',
                      key: 'severity',
                      render: (value: string | null, issue: SellerboardImportIssue) => (
                        <Tag color={value === 'error' ? 'red' : value === 'warning' ? 'gold' : 'default'}>
                          {value === 'error' ? t('Error') : value === 'warning' ? t('Warning') : issue.status ?? t('Issue')}
                        </Tag>
                      ),
                    },
                    {
                      title: t('Issue'),
                      dataIndex: 'code',
                      key: 'code',
                      render: (value: string | null) => <Typography.Text>{value?.replace(/_/g, ' ') ?? t('Issue')}</Typography.Text>,
                    },
                    {
                      title: t('Report'),
                      dataIndex: 'sourceKey',
                      key: 'sourceKey',
                      render: (value: string | null, issue: SellerboardImportIssue) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text>{humanSourceKey(value)}</Typography.Text>
                          {payloadReportName(issue) ? <Typography.Text type="secondary">{payloadReportName(issue)}</Typography.Text> : null}
                        </Space>
                      ),
                    },
                    {
                      title: t('Message'),
                      dataIndex: 'message',
                      key: 'message',
                      render: (value: string | null, issue: SellerboardImportIssue) => (
                        <Space direction="vertical" size={0}>
                          <Space align="start">
                            <Typography.Text>{humanIssueMessage({ ...issue, message: value })}</Typography.Text>
                            {renderIssueHelp({ ...issue, message: value })}
                          </Space>
                          {issue.rowNumber ? <Typography.Text type="secondary">{t('CSV row {{row}}', { row: issue.rowNumber })}</Typography.Text> : null}
                        </Space>
                      ),
                    },
                  ]}
                />
              ) : (
                <Typography.Text type="secondary">{t('No warnings or errors were recorded for this import run.')}</Typography.Text>
              )}
            </Space>
          </Card>
        ))}
      </Space>
    );
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
          <Typography.Text type="secondary">{t('ID …{{id}}', { id: shortSourceId(row.sourceConnectionId) })}</Typography.Text>
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
          <Typography.Text type="secondary">{t('Refresh every {{duration}}', { duration: formatDuration(schedule.refreshIntervalMinutes) })}</Typography.Text>
          <Typography.Text type="secondary">{t('Daily floor {{time}} UTC', { time: schedule.dailyRefreshTime })}</Typography.Text>
          <Typography.Text type="secondary">{t('Retry failures every {{duration}}', { duration: formatDuration(schedule.retryIntervalMinutes) })}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Latest import'),
      dataIndex: 'latestRunStatus',
      key: 'latestRunStatus',
      render: (_: unknown, row: SellerboardSourceRow) => (
        <Space direction="vertical" size={0}>
          <Tag color={statusColor(row.latestRunStatus)}>{t(statusLabel(row.latestRunStatus))}</Tag>
          <Typography.Text type="secondary">{formatTimestamp(row.latestRunAt) ?? t('Never')}</Typography.Text>
          <Typography.Text type="secondary">
            {t('{{rows}} CSV rows imported, {{normalized}} database records saved, {{warnings}} warnings, {{errors}} errors', {
              rows: row.latestRunRowCount,
              normalized: row.latestRunNormalizedCount,
              warnings: row.latestRunWarningCount,
              errors: row.latestRunErrorCount,
            })}
          </Typography.Text>
          {row.latestRunErrorMessage ? (
            <Space align="start">
              <Typography.Text type={isFreshnessMessage({ message: row.latestRunErrorMessage }) ? 'warning' : 'danger'}>
                {humanIssueMessage({ message: row.latestRunErrorMessage })}
              </Typography.Text>
              {renderIssueHelp({ message: row.latestRunErrorMessage })}
            </Space>
          ) : null}
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
          <Button
            size="small"
            type="primary"
            loading={runningSourceId === row.sourceConnectionId}
            disabled={Boolean(runningSourceId)}
            onClick={() => runNow(row.sourceConnectionId)}
          >
            {runningSourceId === row.sourceConnectionId ? t('Running...') : t('Run now')}
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
        <Table
          columns={columns}
          dataSource={rows}
          loading={loading}
          rowKey="sourceConnectionId"
          expandable={{ expandedRowRender: renderImportLogs, expandRowByClick: true }}
        />
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
