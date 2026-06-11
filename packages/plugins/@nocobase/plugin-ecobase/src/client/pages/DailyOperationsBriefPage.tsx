import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Col, DatePicker, Descriptions, Divider, InputNumber, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;
type CompanyOption = { label: string; value: string; timezone?: string };

function unwrapData(response: any): PlainRecord {
  let data = response;
  for (let i = 0; i < 5; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) break;
    data = data.data;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function unwrapRows(response: any): PlainRecord[] {
  let data = response;
  for (let i = 0; i < 5; i += 1) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object' || !('data' in data)) break;
    data = data.data;
  }
  return Array.isArray(data) ? data : [];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function statusColor(value?: string) {
  if (!value) return 'default';
  if (['ready_to_send', 'preview_ready', 'passed', 'success', 'evidence_generated'].includes(value)) return 'green';
  if (value.startsWith('blocked') || value === 'failed' || value === 'send_failed') return 'red';
  if (value.includes('warning') || value === 'not_run' || value === 'not_requested') return 'orange';
  return 'blue';
}

function focusColor(value?: string) {
  switch (value) {
    case 'source_quality':
      return 'red';
    case 'inventory_risk':
    case 'supplier_orders':
      return 'orange';
    case 'buybox':
    case 'velocity':
    case 'profit_gap':
    case 'okr':
      return 'purple';
    default:
      return 'green';
  }
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

function formatNumber(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '—';
}

function normalizeBrief(narrative: PlainRecord | null, evidence: PlainRecord | null) {
  const pack = evidence?.evidencePack ?? {};
  return {
    reportRunId: narrative?.reportRunId ?? evidence?.reportRunId,
    status: narrative?.status ?? evidence?.status,
    validationStatus: narrative?.validationStatus ?? 'not_run',
    deliveryStatus: narrative?.deliveryStatus ?? evidence?.deliveryStatus ?? 'not_requested',
    subject: narrative?.subject,
    bodyMarkdown: narrative?.bodyMarkdown,
    bodyHtml: narrative?.bodyHtml,
    focus: narrative?.focus ?? evidence?.focus ?? pack.focus,
    focusReason: evidence?.focusReason ?? pack.focusReason,
    counts: pack.summaryCounts ?? {},
    evidencePack: pack,
    reportItems: evidence?.reportItems ?? [],
    validationErrors: narrative?.validationErrors ?? [],
    warnings: evidence?.warnings ?? narrative?.warnings ?? [],
    omissions: evidence?.omissions ?? pack.omissions ?? [],
  };
}

export default function DailyOperationsBriefPage() {
  const t = useT();
  const api = useAPIClient();
  const [date, setDate] = useState(todayIsoDate());
  const [company, setCompany] = useState<string | undefined>();
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companyLoading, setCompanyLoading] = useState(false);
  const [maxItems, setMaxItems] = useState(25);
  const [narrative, setNarrative] = useState<PlainRecord | null>(null);
  const [evidence, setEvidence] = useState<PlainRecord | null>(null);
  const [loading, setLoading] = useState<'evidence' | 'narrative' | 'refresh' | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const brief = useMemo(() => normalizeBrief(narrative, evidence), [narrative, evidence]);

  const requestPayload = useCallback((forceRegenerate = false) => ({
    date,
    company,
    timezone: 'Asia/Karachi',
    mode: 'preview',
    maxItems,
    forceRegenerate,
  }), [company, date, maxItems]);

  const loadCompanies = useCallback(async () => {
    setCompanyLoading(true);
    try {
      const response = await api.request({ url: 'ecobaseCompanies:list?paginate=false', method: 'get' });
      const rows = unwrapRows(response);
      setCompanies(rows
        .map((row: PlainRecord) => ({
          label: typeof row.name === 'string' ? row.name : '',
          value: typeof row.name === 'string' ? row.name : '',
          timezone: typeof row.timezone === 'string' ? row.timezone : undefined,
        }))
        .filter((row: CompanyOption) => row.value));
    } finally {
      setCompanyLoading(false);
    }
  }, [api]);

  const loadEvidence = useCallback(async (forceRegenerate = false) => {
    const response = await api.request({
      url: 'ecobaseReports:generateDailyOperationsBriefEvidence',
      method: 'post',
      data: requestPayload(forceRegenerate),
    });
    const nextEvidence = unwrapData(response);
    setEvidence(nextEvidence);
    return nextEvidence;
  }, [api, requestPayload]);

  const generateEvidenceOnly = useCallback(async () => {
    setLoading('evidence');
    setError(null);
    try {
      setNarrative(null);
      await loadEvidence(false);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(null);
    }
  }, [loadEvidence]);

  const generateNarrative = useCallback(async (forceRegenerate = false) => {
    setLoading(forceRegenerate ? 'refresh' : 'narrative');
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseReports:generateDailyOperationsBrief',
        method: 'post',
        data: requestPayload(forceRegenerate),
      });
      setNarrative(unwrapData(response));
      await loadEvidence(false);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(null);
    }
  }, [api, loadEvidence, requestPayload]);

  useEffect(() => {
    void loadCompanies();
    void generateEvidenceOnly();
  }, []);

  const pack = brief.evidencePack ?? {};
  const sourceStatus = Array.isArray(pack.sourceStatus) ? pack.sourceStatus : [];
  const reportItems = Array.isArray(brief.reportItems) ? brief.reportItems : [];
  const warnings = Array.isArray(brief.warnings) ? brief.warnings : [];
  const omissions = Array.isArray(brief.omissions) ? brief.omissions : [];
  const validationErrors = Array.isArray(brief.validationErrors) ? brief.validationErrors : [];

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Daily Operations Brief')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('Preview, refresh, and inspect the same evidence-backed daily brief used by the scheduled workflow. Refresh after order updates or late-day work to regenerate today\'s insights before email delivery is enabled.')}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={error.message} /> : null}

        <Card>
          <Space wrap>
            <DatePicker value={dayjs(date)} onChange={(value) => setDate(value ? value.format('YYYY-MM-DD') : todayIsoDate())} />
            <Select
              allowClear
              showSearch
              placeholder={t('Company')}
              value={company}
              onChange={setCompany}
              loading={companyLoading}
              options={companies}
              optionFilterProp="label"
              style={{ width: 260 }}
            />
            <InputNumber min={1} max={100} value={maxItems} onChange={(value) => setMaxItems(Number(value ?? 25))} addonAfter={t('max items')} />
            <Button onClick={generateEvidenceOnly} loading={loading === 'evidence'}>{t('Load evidence')}</Button>
            <Button type="primary" onClick={() => generateNarrative(false)} loading={loading === 'narrative'}>{t('Generate preview')}</Button>
            <Button danger onClick={() => generateNarrative(true)} loading={loading === 'refresh'}>{t('Refresh after updates')}</Button>
          </Space>
        </Card>

        {brief.reportRunId ? (
          <>
            <Card>
              <Descriptions bordered column={2} size="small">
                <Descriptions.Item label={t('Report run')}>{brief.reportRunId}</Descriptions.Item>
                <Descriptions.Item label={t('Focus')}><Tag color={focusColor(brief.focus)}>{brief.focus ?? '—'}</Tag></Descriptions.Item>
                <Descriptions.Item label={t('Status')}><Tag color={statusColor(brief.status)}>{brief.status ?? '—'}</Tag></Descriptions.Item>
                <Descriptions.Item label={t('Validation')}><Tag color={statusColor(brief.validationStatus)}>{brief.validationStatus ?? 'not_run'}</Tag></Descriptions.Item>
                <Descriptions.Item label={t('Delivery')}><Tag color={statusColor(brief.deliveryStatus)}>{brief.deliveryStatus ?? 'not_requested'}</Tag></Descriptions.Item>
                <Descriptions.Item label={t('Focus reason')} span={2}>{brief.focusReason ?? '—'}</Descriptions.Item>
              </Descriptions>
            </Card>

            <Row gutter={[16, 16]}>
              <Col xs={24} sm={12} md={6}><Card><Statistic title={t('Inventory risks')} value={brief.counts.inventoryRiskCount ?? 0} /></Card></Col>
              <Col xs={24} sm={12} md={6}><Card><Statistic title={t('Supplier orders')} value={brief.counts.supplierOrderContextCount ?? 0} /></Card></Col>
              <Col xs={24} sm={12} md={6}><Card><Statistic title={t('Data warnings')} value={brief.counts.dataWarningCount ?? warnings.length} /></Card></Col>
              <Col xs={24} sm={12} md={6}><Card><Statistic title={t('Trend / OKR signals')} value={(brief.counts.performanceTrendCount ?? 0) + (brief.counts.buyBoxRiskCount ?? 0) + (brief.counts.okrAccountabilityRiskCount ?? 0)} /></Card></Col>
            </Row>

            {validationErrors.length ? <Alert type="error" message={t('Grounding validation blocked the narrative')} description={<ul>{validationErrors.map((item: string) => <li key={item}>{item}</li>)}</ul>} /> : null}
            {omissions.length ? <Alert type="warning" message={t('Omissions')} description={<ul>{omissions.map((item: string) => <li key={item}>{item}</li>)}</ul>} /> : null}

            <Card title={t('Narrative output')}>
              {brief.subject ? <Typography.Title level={4}>{brief.subject}</Typography.Title> : <Alert type="info" message={t('No narrative generated yet. Use Generate preview or Refresh after updates.')} />}
              {brief.bodyHtml ? <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 16 }} dangerouslySetInnerHTML={{ __html: brief.bodyHtml }} /> : null}
              {!brief.bodyHtml && brief.bodyMarkdown ? <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 520, overflow: 'auto' }}>{brief.bodyMarkdown}</pre> : null}
            </Card>

            <Card title={t('Report items')}>
              <Table<PlainRecord>
                rowKey={(row) => row.id ?? `${row.itemType}:${row.sortOrder}:${row.evidenceRefId}`}
                dataSource={reportItems}
                pagination={{ pageSize: 10 }}
                columns={[
                  { title: t('Type'), dataIndex: 'itemType', key: 'itemType', render: (value) => <Tag>{value}</Tag> },
                  { title: t('Severity'), dataIndex: 'severity', key: 'severity', render: (value) => <Tag color={severityColor(value)}>{value}</Tag> },
                  { title: t('Title'), dataIndex: 'title', key: 'title' },
                  { title: t('Evidence'), key: 'evidence', render: (_, row) => `${row.evidenceRefType ?? ''}:${row.evidenceRefId ?? ''}` },
                ]}
              />
            </Card>

            <Card title={t('Source status and warnings')}>
              <Table<PlainRecord>
                rowKey={(row) => row.sourceConnectionId ?? row.evidenceId}
                dataSource={sourceStatus}
                pagination={{ pageSize: 8 }}
                expandable={{ expandedRowRender: (row) => <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(row.warnings ?? [], null, 2)}</pre> }}
                columns={[
                  { title: t('Connection'), dataIndex: 'connectionName', key: 'connectionName' },
                  { title: t('Domain'), dataIndex: 'domain', key: 'domain' },
                  { title: t('Latest status'), dataIndex: 'latestRunStatus', key: 'latestRunStatus', render: (value) => <Tag color={statusColor(value)}>{value ?? 'no runs'}</Tag> },
                  { title: t('Rows'), dataIndex: 'rowCount', key: 'rowCount', render: formatNumber },
                  { title: t('Warnings'), dataIndex: 'warningCount', key: 'warningCount', render: formatNumber },
                  { title: t('Last run time'), dataIndex: 'lastRunAt', key: 'lastRunAt', render: (value) => value ?? '—' },
                ]}
              />
              <Divider />
              <Table<PlainRecord>
                rowKey={(row, index) => `${row.code}:${row.evidenceId ?? index}`}
                dataSource={warnings}
                pagination={{ pageSize: 8 }}
                columns={[
                  { title: t('Code'), dataIndex: 'code', key: 'code', render: (value) => <Tag color="orange">{value}</Tag> },
                  { title: t('Severity'), dataIndex: 'severity', key: 'severity', render: (value) => <Tag color={severityColor(value)}>{value}</Tag> },
                  { title: t('Message'), dataIndex: 'message', key: 'message' },
                ]}
              />
            </Card>
          </>
        ) : null}
      </Space>
    </div>
  );
}
