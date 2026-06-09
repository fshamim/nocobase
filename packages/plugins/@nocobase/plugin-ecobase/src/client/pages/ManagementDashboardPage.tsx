import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Descriptions, Input, InputNumber, Space, Table, Tag, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

function unwrapData(response: any): PlainRecord {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) {
      break;
    }
    data = data.data;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function severityColor(value?: string) {
  switch (value) {
    case 'critical':
      return 'red';
    case 'warning':
      return 'orange';
    case 'info':
      return 'blue';
    default:
      return 'default';
  }
}

export default function ManagementDashboardPage() {
  const t = useT();
  const api = useAPIClient();
  const [company, setCompany] = useState('');
  const [period, setPeriod] = useState('2026-W23');
  const [dashboard, setDashboard] = useState<PlainRecord>({});
  const [settings, setSettings] = useState<PlainRecord>({});
  const [buyBoxRiskThreshold, setBuyBoxRiskThreshold] = useState<number | null>(80);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseDashboard:summary',
        method: 'post',
        data: { company: company.trim() || undefined, periodType: 'weekly', period: period.trim() || undefined },
      });
      const nextDashboard = unwrapData(response);
      setDashboard(nextDashboard);
      setSettings(nextDashboard.settings ?? {});
      setBuyBoxRiskThreshold(nextDashboard.settings?.buyBoxRiskThreshold ?? 80);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, company, period]);

  const saveSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseDashboard:updateSettings',
        method: 'post',
        data: { buyBoxRiskThreshold: buyBoxRiskThreshold ?? 80 },
      });
      setSettings(unwrapData(response));
      await loadDashboard();
    } catch (err) {
      setError(err as Error);
      setLoading(false);
    }
  }, [api, buyBoxRiskThreshold, loadDashboard]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const comparisonRows = dashboard.comparison?.accountOrCompany?.rows ?? [];
  const productRows = dashboard.comparison?.planningProducts?.rows ?? [];
  const rawListingRows = dashboard.comparison?.rawListings?.rows ?? [];

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Ecobase management dashboard')}</Typography.Title>
        {error ? <Alert type="error" message={error.message} /> : null}
        <Card>
          <Space wrap>
            <Input placeholder={t('Company filter')} value={company} onChange={(event) => setCompany(event.target.value)} style={{ width: 260 }} />
            <Input placeholder={t('Weekly period YYYY-Www')} value={period} onChange={(event) => setPeriod(event.target.value)} style={{ width: 220 }} />
            <Button type="primary" loading={loading} onClick={loadDashboard}>{t('Refresh dashboard')}</Button>
          </Space>
        </Card>
        <Card title={t('MVP settings')}>
          <Space wrap>
            <span>{t('Buy Box risk threshold')}</span>
            <InputNumber value={buyBoxRiskThreshold} min={0} max={100} onChange={(value) => setBuyBoxRiskThreshold(value)} />
            <Button onClick={saveSettings} loading={loading}>{t('Save setting')}</Button>
            <span>{t('Report schedule')}: {settings.dailyReportSchedule ?? '08:00'} {settings.timezone ?? 'Asia/Karachi'}</span>
          </Space>
        </Card>
        <Card title={t('Import/source status and warnings')}>
          <Descriptions column={3} size="small">
            <Descriptions.Item label={t('Sources')}>{dashboard.warningSummary?.sourceCount ?? 0}</Descriptions.Item>
            <Descriptions.Item label={t('Warnings')}>{dashboard.warningSummary?.warningCount ?? 0}</Descriptions.Item>
            <Descriptions.Item label={t('Stale/blocked')}>{dashboard.warningSummary?.staleOrBlockedSources?.length ?? 0}</Descriptions.Item>
          </Descriptions>
          <Table<PlainRecord>
            rowKey={(row) => row.sourceConnectionId}
            dataSource={dashboard.importStatuses ?? []}
            pagination={{ pageSize: 5 }}
            columns={[
              { title: t('Source'), dataIndex: 'connectionName', key: 'connectionName' },
              { title: t('Type'), dataIndex: 'sourceType', key: 'sourceType' },
              { title: t('Latest run'), dataIndex: 'latestRunStatus', key: 'latestRunStatus' },
              { title: t('Warnings'), dataIndex: 'warningCount', key: 'warningCount' },
            ]}
          />
        </Card>
        <Card title={t('Profit and stock rollups')}>
          <Table<PlainRecord>
            rowKey={(row) => row.key}
            dataSource={dashboard.profitStockRollups?.byCompany ?? []}
            pagination={false}
            columns={[
              { title: t('Company'), dataIndex: 'key', key: 'key' },
              { title: t('Products'), dataIndex: 'productCount', key: 'productCount' },
              { title: t('Sellable stock'), dataIndex: 'sellableStock', key: 'sellableStock' },
              { title: t('Replenishment stock'), dataIndex: 'pipelineStock', key: 'pipelineStock' },
              { title: t('Profit gap'), dataIndex: 'profitGap', key: 'profitGap' },
            ]}
          />
        </Card>
        <Card title={t('Week/month/date-range comparison')}>
          <Table<PlainRecord>
            rowKey={(row) => row.key}
            dataSource={comparisonRows}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: t('Group'), dataIndex: 'label', key: 'label' },
              { title: t('Current profit'), key: 'currentProfit', render: (_, row) => row.current?.netProfit },
              { title: t('Previous profit'), key: 'previousProfit', render: (_, row) => row.previous?.netProfit },
              { title: t('Profit change'), key: 'change', render: (_, row) => row.change?.netProfit },
              { title: t('Target gap'), key: 'targetGap', render: (_, row) => row.current?.targetGap },
              { title: t('Class'), dataIndex: 'classification', key: 'classification' },
            ]}
          />
        </Card>
        <Card title={t('Off-track / at-risk products')}>
          <Table<PlainRecord>
            rowKey={(row) => row.alertId ?? row.planningProductId}
            dataSource={dashboard.atRiskProducts ?? []}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: t('ASIN'), dataIndex: 'canonicalAsin', key: 'canonicalAsin' },
              { title: t('Tier'), dataIndex: 'tier', key: 'tier' },
              { title: t('Days cover'), dataIndex: 'daysOfCover', key: 'daysOfCover' },
              { title: t('Restock deadline'), dataIndex: 'restockDeadline', key: 'restockDeadline' },
              { title: t('Profit gap'), dataIndex: 'profitGap', key: 'profitGap' },
              { title: t('Severity'), dataIndex: 'severity', key: 'severity', render: (value) => <Tag color={severityColor(value)}>{value}</Tag> },
              { title: t('Root cause'), dataIndex: 'primaryRootCauseCode', key: 'primaryRootCauseCode' },
              { title: t('Action'), dataIndex: 'actionRequired', key: 'actionRequired' },
            ]}
          />
        </Card>
        <Card title={t('Open alerts')}>
          <Table<PlainRecord>
            rowKey={(row) => row.id ?? row.dedupeKey}
            dataSource={dashboard.openAlerts ?? []}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: t('Type'), dataIndex: 'alertType', key: 'alertType' },
              { title: t('Severity'), dataIndex: 'severity', key: 'severity', render: (value) => <Tag color={severityColor(value)}>{value}</Tag> },
              { title: t('Status'), dataIndex: 'status', key: 'status' },
              { title: t('Subject'), dataIndex: 'subjectRef', key: 'subjectRef' },
              { title: t('Action'), dataIndex: 'actionRequired', key: 'actionRequired' },
            ]}
          />
        </Card>
        <Card title={t('Supplier-order delays and missing updates')}>
          <Table<PlainRecord>
            rowKey={(row) => `${row.orderRef}:${row.linkedPlanningProductId}`}
            dataSource={dashboard.supplierOrderDelays ?? []}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: t('Supplier'), dataIndex: 'supplier', key: 'supplier' },
              { title: t('Order ref'), dataIndex: 'orderRef', key: 'orderRef' },
              { title: t('Status'), dataIndex: 'status', key: 'status' },
              { title: t('Sellable date'), dataIndex: 'expectedSellableDate', key: 'expectedSellableDate' },
              { title: t('Already placed'), key: 'alreadyPlacedForRisk', render: (_, row) => String(Boolean(row.alreadyPlacedForRisk)) },
              { title: t('Latest contact'), dataIndex: 'latestSupplierContactAt', key: 'latestSupplierContactAt' },
              { title: t('Lead-time age'), dataIndex: 'leadTimeAgeDays', key: 'leadTimeAgeDays' },
              { title: t('Severity'), dataIndex: 'severity', key: 'severity' },
            ]}
          />
        </Card>
        <Card title={t('Accountability')}>
          <Table<PlainRecord>
            rowKey={(row) => row.externalTaskId ?? row.id ?? row.taskName}
            dataSource={dashboard.accountability?.latestTasks ?? []}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: t('Task'), dataIndex: 'taskName', key: 'taskName' },
              { title: t('Owner'), dataIndex: 'assignee', key: 'assignee' },
              { title: t('Area'), dataIndex: 'operationalArea', key: 'operationalArea' },
              { title: t('Priority'), dataIndex: 'priority', key: 'priority' },
              { title: t('Status'), dataIndex: 'status', key: 'status' },
              { title: t('Last update'), dataIndex: 'lastMeaningfulUpdateAt', key: 'lastMeaningfulUpdateAt' },
            ]}
          />
        </Card>
        <Card title={t('Drilldown evidence')}>
          <Typography.Text>{t('Alert/product drilldowns expose evidence and data warnings through the dashboard API.')}</Typography.Text>
          <pre style={{ maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(dashboard.drilldowns?.alerts?.slice?.(0, 5) ?? [], null, 2)}</pre>
        </Card>
        <Card title={t('Product and raw listing drilldown samples')}>
          <Descriptions column={2} size="small">
            <Descriptions.Item label={t('Planning-product rows')}>{productRows.length}</Descriptions.Item>
            <Descriptions.Item label={t('Raw listing/SKU rows')}>{rawListingRows.length}</Descriptions.Item>
          </Descriptions>
        </Card>
      </Space>
    </div>
  );
}
