import { useAPIClient } from '@nocobase/client';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Popover,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;
type CompanyOption = { label: string; value: string; timezone?: string };
type TrendPeriod = 'yesterday' | '7d' | '30d';

const DEFAULT_MAX_ITEMS = 25;

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

function rows(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatNumber(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '—';
}

function formatMoney(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—';
}

function numberOr(value: any, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatKpiValue(value: any, unit: string) {
  if (unit === 'currency') return formatMoney(value);
  if (unit === 'percent') {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '—';
  }
  return unit === 'date' ? dateOnly(value) : formatNumber(value);
}

function formatDisplayDate(value: any) {
  const date = dayjs(value);
  return date.isValid() ? date.format('DD MMM YYYY') : '—';
}

function formatTrendWindowLabel(startValue: any, endValue: any) {
  if (!startValue || !endValue) return 'Period not available yet';
  const start = formatDisplayDate(startValue);
  const end = formatDisplayDate(endValue);
  if (start === '—' || end === '—') return 'Period not available yet';
  return start === end ? start : `${start} → ${end}`;
}

function formatKpiDelta(row: PlainRecord) {
  if (row.direction === 'insufficient_history') return 'Insufficient history';
  if (row.unit === 'date') {
    const delta = Number(row.absoluteDelta);
    return Number.isFinite(delta) ? `${delta > 0 ? '+' : ''}${delta}d` : '—';
  }
  const delta = Number(row.absoluteDelta);
  const pct = Number(row.percentDelta);
  if (!Number.isFinite(delta)) return '—';
  return `${delta > 0 ? '+' : ''}${formatKpiValue(delta, row.unit)}${
    Number.isFinite(pct) ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''
  }`;
}

function kpiToneColor(row: PlainRecord) {
  if (row.tone === 'success') return 'green';
  if (row.tone === 'error') return 'red';
  if (row.tone === 'warning') return 'orange';
  return 'default';
}

function kpiToneType(row: PlainRecord) {
  if (row.tone === 'success') return 'success';
  if (row.tone === 'error') return 'danger';
  if (row.tone === 'warning') return 'warning';
  return undefined;
}

function shortText(value: any, fallback = '—') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.length > 72 ? `${value.slice(0, 69)}…` : value;
}

function dateOnly(value: any) {
  return typeof value === 'string' && value ? value.slice(0, 10) : '—';
}

function sumField(items: PlainRecord[], field: string) {
  return items.reduce((total, item) => {
    const value = Number(item[field]);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function countBy(items: PlainRecord[], predicate: (item: PlainRecord) => boolean) {
  return items.reduce((total, item) => total + (predicate(item) ? 1 : 0), 0);
}

function earliestDate(items: PlainRecord[], fields: string[]) {
  return items
    .flatMap((item) => fields.map((field) => item[field]))
    .filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))
    .map((value) => value.slice(0, 10))
    .sort()[0];
}

function normalizeBrief(narrative: PlainRecord | null, evidence: PlainRecord | null) {
  const pack = evidence?.evidencePack ?? {};
  return {
    reportRunId: narrative?.reportRunId ?? evidence?.reportRunId,
    bodyMarkdown: narrative?.bodyMarkdown,
    bodyHtml: narrative?.bodyHtml,
    focus: narrative?.focus ?? evidence?.focus ?? pack.focus,
    focusReason: evidence?.focusReason ?? pack.focusReason,
    evidencePack: pack,
    validationErrors: narrative?.validationErrors ?? [],
  };
}

export default function DailyOperationsBriefPage() {
  const t = useT();
  const api = useAPIClient();
  const [date, setDate] = useState(todayIsoDate());
  const [company, setCompany] = useState<string | undefined>();
  const [trendPeriod, setTrendPeriod] = useState<TrendPeriod>('7d');
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companyLoading, setCompanyLoading] = useState(false);
  const [narrative, setNarrative] = useState<PlainRecord | null>(null);
  const [evidence, setEvidence] = useState<PlainRecord | null>(null);
  const [trend, setTrend] = useState<PlainRecord | null>(null);
  const [loading, setLoading] = useState<'narrative' | 'refresh' | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const brief = useMemo(() => normalizeBrief(narrative, evidence), [narrative, evidence]);

  const requestPayload = useCallback(
    (forceRegenerate = false) => ({
      date,
      company,
      timezone: 'Asia/Karachi',
      mode: 'preview',
      maxItems: DEFAULT_MAX_ITEMS,
      forceRegenerate,
    }),
    [company, date],
  );

  const loadCompanies = useCallback(async () => {
    setCompanyLoading(true);
    try {
      const response = await api.request({ url: 'ecobaseCompanies:list?paginate=false', method: 'get' });
      const companyRows = unwrapRows(response);
      setCompanies(
        companyRows
          .map((row: PlainRecord) => ({
            label: typeof row.name === 'string' ? row.name : '',
            value: typeof row.name === 'string' ? row.name : '',
            timezone: typeof row.timezone === 'string' ? row.timezone : undefined,
          }))
          .filter((row: CompanyOption) => row.value),
      );
    } finally {
      setCompanyLoading(false);
    }
  }, [api]);

  const loadEvidence = useCallback(
    async (forceRegenerate = false) => {
      const response = await api.request({
        url: 'ecobaseReports:generateDailyOperationsBriefEvidence',
        method: 'post',
        data: requestPayload(forceRegenerate),
      });
      const nextEvidence = unwrapData(response);
      setEvidence(nextEvidence);
      return nextEvidence;
    },
    [api, requestPayload],
  );

  const loadTrend = useCallback(
    async (period: TrendPeriod) => {
      const response = await api.request({
        url: 'ecobaseReports:getDailyManagementSnapshotTrend',
        method: 'post',
        data: { ...requestPayload(false), period },
      });
      setTrend(unwrapData(response));
    },
    [api, requestPayload],
  );

  const generateNarrative = useCallback(
    async (forceRegenerate = false) => {
      setLoading('narrative');
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
    },
    [api, loadEvidence, requestPayload],
  );

  const refreshDataAndBrief = useCallback(async () => {
    setLoading('refresh');
    setError(null);
    try {
      await api.request({
        url: 'ecobaseImport:runMedallionPipeline',
        method: 'post',
        data: {
          sourceVersion: date,
          goldLimit: Math.max(DEFAULT_MAX_ITEMS * 4, 500),
          goldOrderLimit: 5000,
        },
      });
      const response = await api.request({
        url: 'ecobaseReports:generateDailyOperationsBrief',
        method: 'post',
        data: requestPayload(true),
      });
      setNarrative(unwrapData(response));
      await loadEvidence(false);
      await loadTrend(trendPeriod);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(null);
    }
  }, [api, date, loadEvidence, loadTrend, requestPayload, trendPeriod]);

  useEffect(() => {
    void loadCompanies();
  }, [loadCompanies]);

  useEffect(() => {
    void generateNarrative(false);
  }, [generateNarrative]);

  useEffect(() => {
    void loadTrend(trendPeriod);
  }, [loadTrend, trendPeriod]);

  const pack = brief.evidencePack ?? {};
  const inventoryRisks = rows(pack.inventoryRisks);
  const orderPlanningRisks = rows(pack.orderPlanningRisks);
  const accountabilityRisks = rows(pack.okrAccountabilityRisks);
  const taskRisks = accountabilityRisks.filter(
    (item) => item.riskType === 'task_overdue' || item.riskType === 'task_inactive',
  );
  const okrRisks = accountabilityRisks.filter((item) => item.riskType === 'okr_off_track');
  const futureSignals = [...rows(pack.performanceTrends), ...rows(pack.buyBoxRisks), ...okrRisks];
  const validationErrors = rows(brief.validationErrors);
  const todayActionCount = inventoryRisks.length + orderPlanningRisks.length + taskRisks.length;
  const inventoryMoneyAtRisk = sumField(inventoryRisks, 'estimatedProfitRisk');
  const orderMoneyAtRisk = sumField(orderPlanningRisks, 'moneyAtRisk');
  const urgentInventoryCount = countBy(inventoryRisks, (item) =>
    ['overdue', 'order_today', 'order_soon', 'missing_lead_time'].includes(item.actionStatus ?? ''),
  );
  const statusCheckCount = countBy(orderPlanningRisks, (item) => Boolean(item.statusCheckRequired));
  const staleOrderCount = countBy(orderPlanningRisks, (item) => Number(item.daysSinceLastActivity) >= 3);
  const earliestOos = earliestDate([...inventoryRisks, ...orderPlanningRisks], ['estimatedOosDate', 'earliestOosDate']);
  const snapshot = trend?.currentSnapshot ?? {};
  const snapshotInventoryMoneyAtRisk = numberOr(snapshot.inventoryMoneyAtRisk, inventoryMoneyAtRisk);
  const snapshotOrderMoneyAtRisk = numberOr(snapshot.orderMoneyAtRisk, orderMoneyAtRisk);
  const snapshotTodayActionCount = numberOr(snapshot.todayActionCount, todayActionCount);
  const snapshotUrgentInventoryCount = numberOr(
    snapshot.urgentInventorySkuCount,
    urgentInventoryCount || inventoryRisks.length,
  );
  const snapshotStatusCheckCount = numberOr(snapshot.ordersNeedingCheck, statusCheckCount);
  const snapshotStaleOrderCount = numberOr(snapshot.staleOrderCount, staleOrderCount + taskRisks.length);
  const snapshotEarliestOos = typeof snapshot.earliestOosDate === 'string' ? snapshot.earliestOosDate : earliestOos;
  const priorityKpis = [
    'inventoryMoneyAtRisk',
    'urgentInventorySkuCount',
    'orderMoneyAtRisk',
    'ordersNeedingCheck',
    'staleOrderCount',
    'sales',
    'profit',
    'units',
    'buyBoxPct',
    'conversionRate',
  ];
  const trendRows = rows(trend?.kpis)
    .filter((row) => priorityKpis.includes(row.key) && (row.value !== null || row.previousValue !== null))
    .sort((left, right) => priorityKpis.indexOf(left.key) - priorityKpis.indexOf(right.key));
  const currentTrendWindow = trendRows.find((row) => row.sourceWindowStart && row.sourceWindowEnd);
  const currentTrendWindowLabel = currentTrendWindow
    ? formatTrendWindowLabel(currentTrendWindow.sourceWindowStart, currentTrendWindow.sourceWindowEnd)
    : 'Period not available yet';
  const managementActions = [
    ...inventoryRisks.slice(0, 5).map((row) => ({
      key: row.evidenceId ?? `inventory:${row.asin}:${row.sku}`,
      area: 'Inventory',
      subject: row.asin ?? row.sku ?? 'Unknown product',
      detail: row.title ?? row.supplierName ?? row.company,
      signal: row.actionStatus ?? 'review',
      action: row.actionStatus === 'missing_lead_time' ? 'Confirm lead time' : 'Place or adjust order',
      due: row.latestSafeReorderDate ?? row.estimatedOosDate,
      money: row.estimatedProfitRisk,
      owner: row.supplierName,
    })),
    ...orderPlanningRisks.slice(0, 5).map((row) => ({
      key: row.evidenceId ?? `order:${row.orderRef}:${row.orderId}`,
      area: 'Order',
      subject: row.orderRef ?? row.orderId ?? 'Unknown order',
      detail: row.supplierName,
      signal: row.statusCheckRequired ? 'status_check_required' : row.orderRiskType ?? 'review',
      action: row.nextAction ?? 'Update order status',
      due: row.nextActionDueAt ?? row.earliestOosDate,
      money: row.moneyAtRisk,
      owner: row.supplierName,
    })),
    ...taskRisks.slice(0, 5).map((row) => ({
      key: row.evidenceId ?? `task:${row.taskId}`,
      area: 'Task',
      subject: row.taskName ?? row.taskId ?? 'Unknown task',
      detail: row.assignee ?? row.owner,
      signal: row.riskType ?? 'task',
      action: 'Unblock owner / update task',
      due: row.dueDate,
      money: undefined,
      owner: row.assignee ?? row.owner,
    })),
  ].slice(0, 10);
  const managementActionMessage =
    snapshotTodayActionCount > 0
      ? t('Today needs management action')
      : t('No major inventory or order exception in the current evidence pack');
  const managementActionDescription = (
    <span>
      {t('Earliest OOS')}: <strong>{snapshotEarliestOos ?? '—'}</strong> · {t('Inventory risk')}:{' '}
      <strong>{formatMoney(snapshotInventoryMoneyAtRisk)}</strong> · {t('Order risk')}:{' '}
      <strong>{formatMoney(snapshotOrderMoneyAtRisk)}</strong> · {brief.focusReason ?? ''}
    </span>
  );

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Daily Operations Brief')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t(
            'Auto-loads the latest gold inventory and order-planning read models, then reuses today’s AI brief unless you refresh it.',
          )}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={error.message} /> : null}

        <Card>
          <Space wrap>
            <DatePicker
              value={dayjs(date)}
              onChange={(value) => setDate(value ? value.format('YYYY-MM-DD') : todayIsoDate())}
            />
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
            <Button type="primary" onClick={() => generateNarrative(true)} loading={loading === 'narrative'}>
              {t('Regenerate AI brief')}
            </Button>
            <Button danger onClick={refreshDataAndBrief} loading={loading === 'refresh'}>
              {t('Refresh data + brief')}
            </Button>
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            {t(
              'Date scopes the saved brief, snapshot trend, source freshness, and gold planning date. Company filters the evidence and selects company-specific brief preferences; clear it for all companies.',
            )}
          </Typography.Paragraph>
        </Card>

        {brief.reportRunId ? (
          <>
            {validationErrors.length ? (
              <Alert
                type="error"
                message={t('Grounding validation blocked the narrative')}
                description={
                  <ul>
                    {validationErrors.map((item: string) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                }
              />
            ) : null}

            <Card title={t('Management KPI trend')}>
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <Space wrap>
                  <Typography.Text>{t('Compare')}:</Typography.Text>
                  <Segmented
                    value={trendPeriod}
                    onChange={(value) => setTrendPeriod(value as TrendPeriod)}
                    options={[
                      { label: t('Yesterday'), value: 'yesterday' },
                      { label: t('7 days'), value: '7d' },
                      { label: t('30 days'), value: '30d' },
                    ]}
                  />
                  <Popover
                    trigger="click"
                    placement="bottom"
                    title={t('How compare works')}
                    content={
                      <Space direction="vertical" style={{ maxWidth: 420 }}>
                        <Typography.Text>
                          {t(
                            'Current is the KPI value for the selected window ending at the latest available data date.',
                          )}
                        </Typography.Text>
                        <Typography.Text>
                          {t(
                            'Change compares Current with the previous same-length window: yesterday vs previous day, 7 days vs previous 7 days, or 30 days vs previous 30 days.',
                          )}
                        </Typography.Text>
                        <Typography.Text>{t('Change % = (current - previous) / abs(previous) × 100.')}</Typography.Text>
                        <Typography.Text>
                          {t('If the previous window is incomplete, the table shows Insufficient history instead.')}
                        </Typography.Text>
                      </Space>
                    }
                  >
                    <Button size="small" type="link">
                      {t('How does this work?')}
                    </Button>
                  </Popover>
                </Space>
                {trendRows.length ? (
                  <Table<PlainRecord>
                    size="small"
                    rowKey={(row) => row.key}
                    dataSource={trendRows}
                    pagination={false}
                    columns={[
                      {
                        title: t('KPI'),
                        dataIndex: 'label',
                        key: 'label',
                        render: (value) => <Typography.Text>{value}</Typography.Text>,
                      },
                      {
                        title: (
                          <Space direction="vertical" size={0}>
                            <Typography.Text>{t('Current')}</Typography.Text>
                            <Typography.Text style={{ color: '#1677ff', fontSize: 12, fontStyle: 'italic' }}>
                              {currentTrendWindowLabel}
                            </Typography.Text>
                          </Space>
                        ),
                        key: 'value',
                        render: (_, row) => (
                          <Typography.Text strong type={row.tone === 'error' ? 'danger' : undefined}>
                            {formatKpiValue(row.value, row.unit)}
                          </Typography.Text>
                        ),
                      },
                      {
                        title: `${t('Change')} (${trendPeriod})`,
                        key: 'delta',
                        render: (_, row) =>
                          row.direction === 'insufficient_history' ? (
                            <Tag color="default">{formatKpiDelta(row)}</Tag>
                          ) : (
                            <Typography.Text type={kpiToneType(row)}>{formatKpiDelta(row)}</Typography.Text>
                          ),
                      },
                      {
                        title: t('What it means'),
                        dataIndex: 'explanation',
                        key: 'explanation',
                        render: (value) => <Typography.Text>{value}</Typography.Text>,
                      },
                    ]}
                  />
                ) : (
                  <Alert
                    type="info"
                    message={t(
                      'KPI trends use Gold KPI facts. Sales/profit trends appear after Silver daily facts are backfilled; risk trends begin after daily Gold risk facts accumulate.',
                    )}
                  />
                )}
              </Space>
            </Card>

            {brief.bodyHtml || brief.bodyMarkdown ? (
              <Card title={t('AI action brief')}>
                <Alert
                  showIcon
                  type={snapshotTodayActionCount > 0 ? 'warning' : 'success'}
                  message={managementActionMessage}
                  description={managementActionDescription}
                  style={{ marginBottom: 16 }}
                />
                {brief.bodyHtml ? <div dangerouslySetInnerHTML={{ __html: brief.bodyHtml }} /> : null}
                {!brief.bodyHtml && brief.bodyMarkdown ? (
                  <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 520, overflow: 'auto' }}>{brief.bodyMarkdown}</pre>
                ) : null}
              </Card>
            ) : (
              <Alert type="info" message={t('Generating today’s AI action brief from the gold planning data…')} />
            )}

            <Card title={t("Today's decision queue")}>
              {managementActions.length ? (
                <Table<PlainRecord>
                  size="small"
                  rowKey={(row) => row.key}
                  dataSource={managementActions}
                  pagination={false}
                  columns={[
                    {
                      title: t('Area'),
                      dataIndex: 'area',
                      key: 'area',
                      render: (value) => (
                        <Tag color={value === 'Inventory' ? 'orange' : value === 'Order' ? 'red' : 'purple'}>
                          {value}
                        </Tag>
                      ),
                    },
                    {
                      title: t('What management should look at'),
                      key: 'subject',
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text strong>{row.subject}</Typography.Text>
                          <Typography.Text type="secondary">{shortText(row.detail)}</Typography.Text>
                        </Space>
                      ),
                    },
                    { title: t('Signal'), dataIndex: 'signal', key: 'signal', render: (value) => <Tag>{value}</Tag> },
                    { title: t('Action'), dataIndex: 'action', key: 'action' },
                    { title: t('Owner / supplier'), dataIndex: 'owner', key: 'owner', render: shortText },
                    { title: t('Due / OOS'), dataIndex: 'due', key: 'due', render: dateOnly },
                    { title: t('Risk'), dataIndex: 'money', key: 'money', render: formatMoney },
                  ]}
                />
              ) : (
                <Alert type="success" message={t('No action queue items found for this date/company.')} />
              )}
            </Card>

            <Card title={t('Out-of-stock overview')}>
              {inventoryRisks.length ? (
                <Table<PlainRecord>
                  size="small"
                  rowKey={(row, index) => row.evidenceId ?? `${row.asin}:${row.sku}:${index}`}
                  dataSource={inventoryRisks.slice(0, 12)}
                  pagination={false}
                  columns={[
                    {
                      title: t('Product'),
                      key: 'product',
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text strong>{row.asin ?? row.sku ?? '—'}</Typography.Text>
                          <Typography.Text type="secondary">{shortText(row.title ?? row.company)}</Typography.Text>
                        </Space>
                      ),
                    },
                    { title: t('Company'), dataIndex: 'company', key: 'company', render: shortText },
                    { title: t('Supplier'), dataIndex: 'supplierName', key: 'supplierName', render: shortText },
                    { title: t('OOS date'), dataIndex: 'estimatedOosDate', key: 'estimatedOosDate', render: dateOnly },
                    {
                      title: t('Latest safe order'),
                      dataIndex: 'latestSafeReorderDate',
                      key: 'latestSafeReorderDate',
                      render: dateOnly,
                    },
                    {
                      title: t('Coverage'),
                      key: 'coverage',
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text>{row.supplierOrderState ?? 'no order coverage'}</Typography.Text>
                          <Typography.Text type="secondary">
                            {row.supplierOrderRef ?? '—'} · {formatNumber(row.openSupplierOrderCoverageQty)} units
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: t('Action'),
                      dataIndex: 'actionStatus',
                      key: 'actionStatus',
                      render: (value) => <Tag color="orange">{value ?? 'review'}</Tag>,
                    },
                    {
                      title: t('Money at risk'),
                      dataIndex: 'estimatedProfitRisk',
                      key: 'estimatedProfitRisk',
                      render: formatMoney,
                    },
                  ]}
                />
              ) : (
                <Alert type="success" message={t('No out-of-stock risks found for this date/company.')} />
              )}
            </Card>

            <Card title={t('Order planning overview')}>
              {orderPlanningRisks.length ? (
                <Table<PlainRecord>
                  size="small"
                  rowKey={(row, index) => row.evidenceId ?? `${row.orderRef}:${index}`}
                  dataSource={orderPlanningRisks.slice(0, 12)}
                  pagination={false}
                  columns={[
                    {
                      title: t('Order'),
                      key: 'order',
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text strong>{row.orderRef ?? row.orderId ?? '—'}</Typography.Text>
                          <Typography.Text type="secondary">{shortText(row.latestComment)}</Typography.Text>
                        </Space>
                      ),
                    },
                    { title: t('Supplier'), dataIndex: 'supplierName', key: 'supplierName', render: shortText },
                    {
                      title: t('Status'),
                      key: 'status',
                      render: (_, row) => (
                        <Tag color={row.statusCheckRequired ? 'red' : 'blue'}>{row.currentStatus ?? 'review'}</Tag>
                      ),
                    },
                    { title: t('Next action'), dataIndex: 'nextAction', key: 'nextAction', render: shortText },
                    { title: t('Due'), dataIndex: 'nextActionDueAt', key: 'nextActionDueAt', render: dateOnly },
                    {
                      title: t('Earliest OOS'),
                      dataIndex: 'earliestOosDate',
                      key: 'earliestOosDate',
                      render: dateOnly,
                    },
                    {
                      title: t('Waiting'),
                      dataIndex: 'daysSinceLastActivity',
                      key: 'daysSinceLastActivity',
                      render: (value) => `${formatNumber(value)}d`,
                    },
                    { title: t('Money at risk'), dataIndex: 'moneyAtRisk', key: 'moneyAtRisk', render: formatMoney },
                  ]}
                />
              ) : (
                <Alert
                  type="info"
                  message={t('No order-planning rows are available in this evidence pack.')}
                  description={t(
                    'Use Refresh data + brief to rebuild the gold order-planning read model, then reload this page.',
                  )}
                />
              )}
            </Card>

            <Row gutter={[16, 16]}>
              <Col xs={24} lg={12}>
                <Card title={t('Tasks / owners')}>
                  {taskRisks.length ? (
                    <Table<PlainRecord>
                      size="small"
                      rowKey={(row, index) => row.evidenceId ?? `${row.taskId}:${index}`}
                      dataSource={taskRisks.slice(0, 8)}
                      pagination={false}
                      columns={[
                        {
                          title: t('Task'),
                          key: 'task',
                          render: (_, row) => (
                            <Space direction="vertical" size={0}>
                              <Typography.Text strong>{shortText(row.taskName ?? row.taskId)}</Typography.Text>
                              <Typography.Text type="secondary">{row.assignee ?? row.owner ?? '—'}</Typography.Text>
                            </Space>
                          ),
                        },
                        {
                          title: t('Signal'),
                          dataIndex: 'riskType',
                          key: 'riskType',
                          render: (value) => <Tag color="purple">{value}</Tag>,
                        },
                        { title: t('Due'), dataIndex: 'dueDate', key: 'dueDate', render: dateOnly },
                        {
                          title: t('Last update'),
                          dataIndex: 'lastMeaningfulUpdateAt',
                          key: 'lastMeaningfulUpdateAt',
                          render: dateOnly,
                        },
                      ]}
                    />
                  ) : (
                    <Alert type="success" message={t('No overdue or inactive task signal in this evidence pack.')} />
                  )}
                </Card>
              </Col>
              <Col xs={24} lg={12}>
                <Card title={t('Future signals')}>
                  {futureSignals.length ? (
                    <Table<PlainRecord>
                      size="small"
                      rowKey={(row, index) => row.evidenceId ?? `${row.trendType ?? row.riskType ?? 'signal'}:${index}`}
                      dataSource={futureSignals.slice(0, 8)}
                      pagination={false}
                      columns={[
                        {
                          title: t('Area'),
                          key: 'area',
                          render: (_, row) => (
                            <Tag color="purple">
                              {row.trendType ??
                                (row.currentBuyBoxWinRate !== undefined ? 'buybox' : row.riskType ?? 'signal')}
                            </Tag>
                          ),
                        },
                        {
                          title: t('Subject'),
                          key: 'subject',
                          render: (_, row) => row.asin ?? row.sku ?? row.okrTitle ?? row.metricName ?? '—',
                        },
                        {
                          title: t('Impact'),
                          key: 'impact',
                          render: (_, row) =>
                            row.estimatedProfitImpact ??
                            row.profitGap ??
                            row.winRateDropPoints ??
                            row.progressPercent ??
                            '—',
                        },
                      ]}
                    />
                  ) : (
                    <Alert
                      type="info"
                      message={t(
                        'Buy Box, profit planning, and OKR signals will appear when their gold evidence exists.',
                      )}
                    />
                  )}
                </Card>
              </Col>
            </Row>
          </>
        ) : null}
      </Space>
    </div>
  );
}
