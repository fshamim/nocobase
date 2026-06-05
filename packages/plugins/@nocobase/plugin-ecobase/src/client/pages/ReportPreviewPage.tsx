import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Input, Select, Space, Table, Tag, Typography } from 'antd';
import React, { useCallback, useState } from 'react';
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
    default:
      return 'blue';
  }
}

export default function ReportPreviewPage() {
  const t = useT();
  const api = useAPIClient();
  const [company, setCompany] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [period, setPeriod] = useState('2026-06-05');
  const [report, setReport] = useState<PlainRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseReports:generatePreview',
        method: 'post',
        data: {
          company: company.trim() || undefined,
          frequency,
          period,
          date: frequency === 'daily' ? period : undefined,
          emailEnabled: frequency === 'daily',
        },
      });
      setReport(unwrapData(response));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, company, frequency, period]);

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Ecobase report preview')}</Typography.Title>
        {error ? <Alert type="error" message={error.message} /> : null}
        <Card>
          <Space wrap>
            <Input placeholder={t('Company filter')} value={company} onChange={(event) => setCompany(event.target.value)} style={{ width: 240 }} />
            <Select value={frequency} onChange={setFrequency} style={{ width: 140 }} options={[{ value: 'daily' }, { value: 'weekly' }, { value: 'monthly' }]} />
            <Input placeholder={t('Date / period')} value={period} onChange={(event) => setPeriod(event.target.value)} style={{ width: 180 }} />
            <Button type="primary" onClick={generate} loading={loading}>{t('Generate preview')}</Button>
          </Space>
        </Card>
        {report ? (
          <>
            <Alert
              type={report.emailStatus === 'email_not_configured' || report.emailStatus === 'scheduled_not_configured' ? 'warning' : 'success'}
              message={`${t('Report status')}: ${report.status}; ${t('email')}: ${report.emailStatus}`}
              description={report.executiveSummary}
            />
            <Card title={t('Report items')}>
              <Table<PlainRecord>
                rowKey={(row) => row.id ?? `${row.itemType}:${row.sortOrder}`}
                dataSource={report.items ?? []}
                pagination={{ pageSize: 20 }}
                columns={[
                  { title: t('Type'), dataIndex: 'itemType', key: 'itemType' },
                  { title: t('Severity'), dataIndex: 'severity', key: 'severity', render: (value) => <Tag color={severityColor(value)}>{value}</Tag> },
                  { title: t('Title'), dataIndex: 'title', key: 'title' },
                  { title: t('Evidence'), key: 'evidence', render: (_, row) => `${row.evidenceRefType ?? ''}:${row.evidenceRefId ?? ''}` },
                ]}
              />
            </Card>
            <Card title={t('Rendered preview')}>
              <pre style={{ maxHeight: 420, overflow: 'auto' }}>{report.preview}</pre>
            </Card>
          </>
        ) : null}
      </Space>
    </div>
  );
}
