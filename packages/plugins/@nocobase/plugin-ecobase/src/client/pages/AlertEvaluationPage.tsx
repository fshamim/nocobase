import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

function unwrapRows(response: any): PlainRecord[] {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) {
      break;
    }
    data = data.data;
  }
  return Array.isArray(data) ? data : [];
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

export default function AlertEvaluationPage() {
  const t = useT();
  const api = useAPIClient();
  const [company, setCompany] = useState('');
  const [calculationDate, setCalculationDate] = useState('');
  const [alerts, setAlerts] = useState<PlainRecord[]>([]);
  const [lastRun, setLastRun] = useState<PlainRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseAlerts:list',
        method: 'post',
        data: { company: company.trim() || undefined, status: 'open', limit: 100 },
      });
      setAlerts(unwrapRows(response));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, company]);

  const evaluate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseAlerts:evaluate',
        method: 'post',
        data: { company: company.trim() || undefined, calculationDate: calculationDate.trim() || undefined },
      });
      setLastRun(response?.data?.data ?? response?.data ?? response);
      await loadAlerts();
    } catch (err) {
      setError(err as Error);
      setLoading(false);
    }
  }, [api, calculationDate, company, loadAlerts]);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Ecobase alert evaluation')}</Typography.Title>
        {error ? <Alert type="error" message={error.message} /> : null}
        <Card>
          <Space wrap>
            <Input placeholder={t('Company filter')} value={company} onChange={(event) => setCompany(event.target.value)} style={{ width: 260 }} />
            <Input placeholder={t('Calculation date YYYY-MM-DD')} value={calculationDate} onChange={(event) => setCalculationDate(event.target.value)} style={{ width: 240 }} />
            <Button onClick={loadAlerts} loading={loading}>{t('Refresh alerts')}</Button>
            <Button type="primary" onClick={evaluate} loading={loading}>{t('Run deterministic evaluation')}</Button>
          </Space>
        </Card>
        {lastRun ? (
          <Alert
            type="success"
            message={t('Last evaluation run')}
            description={`Products evaluated: ${lastRun.productCount ?? 0}; summaries: ${(lastRun.summaries ?? []).length}`}
          />
        ) : null}
        <Card title={t('Open deterministic alerts')}>
          <Table<PlainRecord>
            loading={loading}
            rowKey={(row) => row.id ?? row.dedupeKey}
            dataSource={alerts}
            pagination={{ pageSize: 20 }}
            columns={[
              { title: t('Company'), dataIndex: 'company', key: 'company' },
              { title: t('ASIN'), dataIndex: 'canonicalAsin', key: 'canonicalAsin' },
              { title: t('Type'), dataIndex: 'alertType', key: 'alertType' },
              { title: t('Severity'), dataIndex: 'severity', key: 'severity', render: (value) => <Tag color={severityColor(value)}>{value}</Tag> },
              { title: t('Status'), dataIndex: 'status', key: 'status' },
              { title: t('Root cause'), dataIndex: 'primaryRootCauseCode', key: 'primaryRootCauseCode' },
              { title: t('Subject'), dataIndex: 'subjectRef', key: 'subjectRef' },
              { title: t('Action required'), dataIndex: 'actionRequired', key: 'actionRequired' },
              { title: t('Last seen'), dataIndex: 'lastSeenAt', key: 'lastSeenAt' },
            ]}
          />
        </Card>
      </Space>
    </div>
  );
}
