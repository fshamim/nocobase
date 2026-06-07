import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Col, DatePicker, Descriptions, Drawer, InputNumber, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

interface DigestPreview {
  summary: PlainRecord;
  sections: {
    orderNow: PlainRecord[];
    suppliersToContactFirst: PlainRecord[];
    supplierActionItems: PlainRecord[];
    staleLeadTimes: PlainRecord[];
  };
}

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

function unwrapDigest(response: any): DigestPreview {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || 'summary' in data || !('data' in data)) {
      break;
    }
    data = data.data;
  }
  return {
    summary: data?.summary ?? {},
    sections: {
      orderNow: Array.isArray(data?.sections?.orderNow) ? data.sections.orderNow : [],
      suppliersToContactFirst: Array.isArray(data?.sections?.suppliersToContactFirst) ? data.sections.suppliersToContactFirst : [],
      supplierActionItems: Array.isArray(data?.sections?.supplierActionItems) ? data.sections.supplierActionItems : [],
      staleLeadTimes: Array.isArray(data?.sections?.staleLeadTimes) ? data.sections.staleLeadTimes : [],
    },
  };
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function actionColor(value?: string) {
  switch (value) {
    case 'overdue':
      return 'red';
    case 'order_today':
      return 'volcano';
    case 'missing_lead_time':
      return 'gold';
    case 'order_soon':
      return 'orange';
    case 'already_ordered':
      return 'blue';
    case 'watch':
      return 'cyan';
    case 'sufficient_stock':
      return 'green';
    case 'excluded':
      return 'default';
    default:
      return 'default';
  }
}

function tierColor(value?: string) {
  switch (value) {
    case 'A':
      return 'green';
    case 'B':
      return 'gold';
    case 'C':
      return 'magenta';
    default:
      return 'default';
  }
}

function freshnessColor(value?: string) {
  switch (value) {
    case 'fresh':
      return 'green';
    case 'stale':
      return 'orange';
    case 'missing':
      return 'red';
    default:
      return 'default';
  }
}

function formatNumber(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
}

function formatCurrency(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—';
}

function formatDate(value: any) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 10) : '—';
}

function relativeDateLabel(value: any, baseDate: string) {
  if (typeof value !== 'string' || value.length === 0) return { label: '—', detail: undefined };
  const target = dayjs(value.slice(0, 10));
  const base = dayjs(baseDate);
  const diff = target.diff(base, 'day');
  if (diff < 0) return { label: `${Math.abs(diff)} days overdue`, detail: value.slice(0, 10), color: 'red' };
  if (diff === 0) return { label: 'Today', detail: value.slice(0, 10), color: 'volcano' };
  if (diff === 1) return { label: 'Tomorrow', detail: value.slice(0, 10), color: 'orange' };
  return { label: `In ${diff} days`, detail: value.slice(0, 10), color: diff <= 7 ? 'gold' : 'default' };
}

function StockStatus({ row, t }: { row: PlainRecord; t: (key: string) => string }) {
  const reserved = Number(row.reservedStock ?? 0);
  const sellable = Number(row.sellableStock ?? 0);
  const pipeline = Number(row.pipelineStock ?? 0);
  const reservedColor = reserved > sellable ? 'red' : reserved > 0 ? 'orange' : 'default';
  return (
    <Space direction="vertical" size={4}>
      <Space size={4} wrap>
        <Tag color="blue">{t('Total')} {formatNumber(row.currentPlanningStock)}</Tag>
        {row.stuck ? <Tag color="purple">{t('STUCK')}</Tag> : null}
      </Space>
      <Space size={4} wrap>
        <Tag color={sellable > 0 ? 'green' : 'red'}>{t('Sellable')} {formatNumber(sellable)}</Tag>
        <Tag color={reservedColor}>{t('Reserved')} {formatNumber(reserved)}</Tag>
        <Tag color={pipeline > 0 ? 'cyan' : 'default'}>{t('Pipeline')} {formatNumber(pipeline)}</Tag>
      </Space>
    </Space>
  );
}

function leadTimeSourceText(row: PlainRecord) {
  if (row.leadTimeSource === 'planning_parameter_without_supplier_mapping') {
    return 'Lead time is coming from the planning-parameter import for this ASIN/company; supplier mapping is still missing.';
  }
  if (row.leadTimeSource === 'supplier_or_planning_parameter') {
    return 'Lead time is coming from supplier data when available, otherwise the imported planning parameter.';
  }
  return 'Lead time source is not yet classified.';
}

function monetaryRiskText(row: PlainRecord) {
  if (row.estimatedProfitRiskBasis === 'uncovered_oos_days × sales_velocity × profit_per_unit') {
    return 'Formula: max(lead time + safety buffer − days of cover, 0) × sales velocity × profit per unit.';
  }
  if (row.estimatedProfitRiskBasis === 'planning_calculation_estimated_profit_risk') {
    return 'Formula comes from the planning calculation service estimated profit risk.';
  }
  if (row.estimatedProfitRiskBasis === 'imported_missed_profit_or_30_day_profit_forecast') {
    return 'Current fallback: imported missed-profit estimate or 30-day profit forecast, because profit per unit is not available in the imported planning row.';
  }
  return 'Monetary risk is unavailable until profit or missed-profit data is imported.';
}

function nextStepFor(row: PlainRecord) {
  if (!row.supplierName) {
    return 'Find the supplier from OrderDetails history for this ASIN/company, then confirm the current lead time before ordering.';
  }
  switch (row.actionStatus) {
    case 'overdue':
      return 'Order now or confirm an already-placed supplier order immediately.';
    case 'order_today':
      return 'Create or confirm the supplier order today.';
    case 'order_soon':
      return 'Prepare the supplier order before the soon window closes.';
    case 'missing_lead_time':
      return 'Contact the supplier first; lead time is missing or stale before reorder math is trusted.';
    case 'already_ordered':
      return 'Review open order coverage and expected sellable date.';
    case 'missing_velocity':
      return 'Check sales velocity/import data before making an order decision.';
    default:
      return 'Monitor this product; no immediate order action is currently required.';
  }
}

function FilterControl({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return (
    <Col xs={24} md={12} xl={6}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Typography.Text strong>{title}</Typography.Text>
        <Typography.Text type="secondary" style={{ minHeight: 44 }}>{help}</Typography.Text>
        {children}
      </Space>
    </Col>
  );
}

export default function InventoryPlanningPage() {
  const t = useT();
  const api = useAPIClient();
  const [company, setCompany] = useState('');
  const [calculationDate, setCalculationDate] = useState(todayIsoDate());
  const [actionStatus, setActionStatus] = useState<string | undefined>();
  const [tier, setTier] = useState<string | undefined>();
  const [leadTimeFreshnessDays, setLeadTimeFreshnessDays] = useState(60);
  const [orderSoonWindowDays, setOrderSoonWindowDays] = useState(14);
  const [limit, setLimit] = useState(150);
  const [filterOptions, setFilterOptions] = useState<PlainRecord>({});
  const [rows, setRows] = useState<PlainRecord[]>([]);
  const [digest, setDigest] = useState<DigestPreview>(() => unwrapDigest({}));
  const [selectedRow, setSelectedRow] = useState<PlainRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadPlanning = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = {
        company: company.trim() || undefined,
        calculationDate: calculationDate.trim() || undefined,
        leadTimeFreshnessDays,
        orderSoonWindowDays,
        limit,
      };
      const [filtersResponse, rowsResponse, digestResponse] = await Promise.all([
        api.request({ url: 'ecobaseInventoryPlanning:filters', method: 'post', data: {} }),
        api.request({ url: 'ecobaseInventoryPlanning:rows', method: 'post', data: payload }),
        api.request({ url: 'ecobaseInventoryPlanning:digestPreview', method: 'post', data: payload }),
      ]);
      setFilterOptions(unwrapData(filtersResponse));
      setRows(unwrapRows(rowsResponse));
      setDigest(unwrapDigest(digestResponse));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, calculationDate, company, leadTimeFreshnessDays, limit, orderSoonWindowDays]);

  useEffect(() => {
    void loadPlanning();
  }, [loadPlanning]);

  const syncEditableRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await api.request({
        url: 'ecobaseInventoryPlanning:refreshReadModel',
        method: 'post',
        data: {
          company: company || undefined,
          calculationDate: calculationDate || undefined,
          leadTimeFreshnessDays,
          orderSoonWindowDays,
          limit: Math.max(limit, 500),
        },
      });
      await loadPlanning();
    } catch (err) {
      setError(err as Error);
      setLoading(false);
    }
  }, [api, calculationDate, company, leadTimeFreshnessDays, limit, loadPlanning, orderSoonWindowDays]);

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (actionStatus && row.actionStatus !== actionStatus) return false;
        if (tier && row.tier !== tier) return false;
        return true;
      }),
    [actionStatus, rows, tier],
  );

  const columns = [
    {
      title: t('Review'),
      key: 'review',
      fixed: 'left' as const,
      width: 95,
      render: (_value: any, row: PlainRecord) => <Button size="small" onClick={() => setSelectedRow(row)}>{t('Details')}</Button>,
    },
    {
      title: t('Action'),
      dataIndex: 'actionStatus',
      fixed: 'left' as const,
      width: 155,
      render: (value: string) => <Tag color={actionColor(value)}>{t(value ?? 'unknown')}</Tag>,
    },
    {
      title: t('Tier'),
      dataIndex: 'tier',
      width: 90,
      render: (value: string) => <Tag color={tierColor(value)}>{value ?? '—'}</Tag>,
    },
    { title: t('Company'), dataIndex: 'company', width: 170, render: (value: string) => value || '—' },
    { title: t('ASIN'), dataIndex: 'asin', width: 130 },
    { title: t('SKU'), dataIndex: 'sku', width: 150 },
    { title: t('Status'), dataIndex: 'productStatus', width: 130 },
    { title: t('Current stock status'), key: 'stockStatus', width: 260, render: (_value: any, row: PlainRecord) => <StockStatus row={row} t={t} /> },
    {
      title: t('Supplier'),
      dataIndex: 'supplierName',
      width: 210,
      render: (value: string, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <span>{value || '—'}</span>
          <Typography.Text type="secondary">{row.supplierSource ?? '—'} · {row.supplierConfidence ?? '—'}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Lead time'),
      dataIndex: 'leadTimeDays',
      width: 150,
      render: (value: number, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <span>{formatNumber(value)} {t('days')}</span>
          <Tag color={freshnessColor(row.leadTimeFreshness)}>{t(row.leadTimeFreshness ?? 'unknown')}</Tag>
        </Space>
      ),
    },
    { title: t('Days cover'), dataIndex: 'daysOfCover', width: 115, render: formatNumber },
    {
      title: t('Order by'),
      dataIndex: 'latestSafeReorderDate',
      width: 150,
      render: (value: string) => {
        const relative = relativeDateLabel(value, calculationDate);
        return <Space direction="vertical" size={0}><Tag color={relative.color}>{t(relative.label)}</Tag><Typography.Text type="secondary">{relative.detail ?? '—'}</Typography.Text></Space>;
      },
    },
    {
      title: t('OOS date'),
      dataIndex: 'estimatedOosDate',
      width: 150,
      render: (value: string) => {
        const relative = relativeDateLabel(value, calculationDate);
        return <Space direction="vertical" size={0}><span>{t(relative.label)}</span><Typography.Text type="secondary">{relative.detail ?? '—'}</Typography.Text></Space>;
      },
    },
    {
      title: t('Suggest qty'),
      dataIndex: 'suggestedReorderQty',
      width: 190,
      render: (value: number, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <span>{formatNumber(value)}</span>
          <Typography.Text type="secondary">{t('velocity × target days − stock − open orders')}</Typography.Text>
        </Space>
      ),
    },
    { title: t('Sellable'), dataIndex: 'sellableStock', width: 105, render: formatNumber },
    { title: t('Reserved'), dataIndex: 'reservedStock', width: 105, render: formatNumber },
    { title: t('Inbound'), dataIndex: 'inboundStock', width: 105, render: formatNumber },
    { title: t('Ordered'), dataIndex: 'orderedStock', width: 105, render: formatNumber },
    { title: t('Prep'), dataIndex: 'prepStock', width: 95, render: formatNumber },
    { title: t('Open order coverage'), dataIndex: 'openOrderCoverageQty', width: 170, render: formatNumber },
    {
      title: t('Stuck'),
      dataIndex: 'stuck',
      width: 90,
      render: (value: boolean) => (value ? <Tag color="purple">{t('Check')}</Tag> : <Tag>{t('No')}</Tag>),
    },
    { title: t('Profit risk'), dataIndex: 'estimatedProfitRisk', width: 125, render: formatNumber },
  ];

  return (
    <div style={{ padding: 24 }}>
      <style>{`
        .ecobase-inventory-table .ecobase-tier-A > td { background: #f6ffed !important; }
        .ecobase-inventory-table .ecobase-tier-B > td { background: #fffbe6 !important; }
        .ecobase-inventory-table .ecobase-tier-C > td { background: #fff1f0 !important; }
      `}</style>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Inventory planning')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('One-stop queue for what to order today, what should already have been ordered, and which supplier should be contacted first.')}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={error.message} /> : null}
        <Card title={t('Operator filters')} extra={<Typography.Text type="secondary">{t('Use these controls to narrow the queue before deciding what to order or who to contact.')}</Typography.Text>}>
          <Row gutter={[24, 20]} align="bottom">
            <FilterControl title={t('Company')} help={t('Choose the legal entity/account whose stock and supplier rows you want to review. Leave empty for all companies.')}>
              <Select
                allowClear
                showSearch
                placeholder={t('All companies')}
                value={company || undefined}
                onChange={(value) => setCompany(value ?? '')}
                style={{ width: '100%' }}
                options={(Array.isArray(filterOptions.companies) ? filterOptions.companies : []).map((value: string) => ({ value, label: value }))}
              />
            </FilterControl>
            <FilterControl title={t('Planning date')} help={t('The date used for relative order-by timing such as Today, Tomorrow, or In N days.')}>
              <DatePicker
                allowClear={false}
                value={calculationDate ? dayjs(calculationDate) : undefined}
                onChange={(_date, dateString) => setCalculationDate(Array.isArray(dateString) ? dateString[0] : dateString)}
                style={{ width: '100%' }}
              />
            </FilterControl>
            <FilterControl title={t('Action status')} help={t('Focus on overdue, order-today, lead-time problems, already-ordered rows, or watch-list products.')}>
              <Select
                allowClear
                placeholder={t('Any action')}
                value={actionStatus}
                onChange={setActionStatus}
                style={{ width: '100%' }}
                options={(Array.isArray(filterOptions.actionStatuses) ? filterOptions.actionStatuses : []).map((value: string) => ({ value, label: t(value) }))}
              />
            </FilterControl>
            <FilterControl title={t('Profit tier')} help={t('Prioritize A/B/C products by expected profit impact. Tier A is the most important.')}>
              <Select
                allowClear
                placeholder={t('Any tier')}
                value={tier}
                onChange={setTier}
                style={{ width: '100%' }}
                options={(Array.isArray(filterOptions.tiers) ? filterOptions.tiers : ['A', 'B', 'C']).map((value: string) => ({ value, label: value }))}
              />
            </FilterControl>
            <FilterControl title={t('Lead-time stale after')} help={t('How many days a supplier lead time remains trusted before it becomes a contact-first warning.')}>
              <InputNumber addonAfter={t('days')} min={1} value={leadTimeFreshnessDays} onChange={(value) => setLeadTimeFreshnessDays(Number(value ?? 60))} style={{ width: '100%' }} />
            </FilterControl>
            <FilterControl title={t('Soon window')} help={t('Rows due within this many days are marked as order soon.')}>
              <InputNumber addonAfter={t('days')} min={1} value={orderSoonWindowDays} onChange={(value) => setOrderSoonWindowDays(Number(value ?? 14))} style={{ width: '100%' }} />
            </FilterControl>
            <FilterControl title={t('Rows to load')} help={t('Caps the queue size so the operator page stays fast and focused.')}>
              <InputNumber min={25} max={500} value={limit} onChange={(value) => setLimit(Number(value ?? 150))} style={{ width: '100%' }} />
            </FilterControl>
            <Col xs={24} md={12} xl={6}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Button type="primary" block loading={loading} onClick={loadPlanning}>{t('Refresh planning')}</Button>
                <Button block loading={loading} onClick={syncEditableRows}>{t('Sync editable table')}</Button>
              </Space>
            </Col>
          </Row>
        </Card>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={4}><Card><Statistic title={t('Overdue')} value={digest.summary.overdue ?? 0} valueStyle={{ color: '#cf1322' }} /></Card></Col>
          <Col xs={24} sm={12} lg={4}><Card><Statistic title={t('Order today')} value={digest.summary.orderToday ?? 0} valueStyle={{ color: '#d4380d' }} /></Card></Col>
          <Col xs={24} sm={12} lg={4}><Card><Statistic title={t('Order soon')} value={digest.summary.orderSoon ?? 0} valueStyle={{ color: '#fa8c16' }} /></Card></Col>
          <Col xs={24} sm={12} lg={4}><Card><Statistic title={t('At risk')} value={digest.summary.atRisk ?? 0} /></Card></Col>
          <Col xs={24} sm={12} lg={4}><Card><Statistic title={t('Lead-time issues')} value={digest.summary.staleOrMissingLeadTime ?? 0} valueStyle={{ color: '#faad14' }} /></Card></Col>
          <Col xs={24} sm={12} lg={4}><Card><Statistic title={t('Suppliers')} value={digest.summary.suppliersToContact ?? 0} /></Card></Col>
        </Row>
        <Card title={t('Daily digest preview')}
          extra={<Typography.Text type="secondary">{t('Bounded to urgent action items so operators are not overloaded.')}</Typography.Text>}
        >
          <Row gutter={[16, 16]}>
            <Col xs={24}>
              <Typography.Title level={5}>{t('Order now')}</Typography.Title>
              <Typography.Paragraph type="secondary">
                {t('Open a row to see why it appears here and what the next operator action should be. Lead time can exist even when supplier is missing because it may come from the imported ASIN/company planning parameter; the supplier still needs to be recovered from OrderDetails.')}
              </Typography.Paragraph>
              <Table
                size="small"
                rowKey={(row) => row.planningProductId}
                dataSource={digest.sections.orderNow}
                pagination={false}
                onRow={(row) => ({ onClick: () => setSelectedRow(row) })}
                columns={[
                  { title: t('Action'), dataIndex: 'actionStatus', render: (value: string) => <Tag color={actionColor(value)}>{t(value)}</Tag> },
                  { title: t('Tier'), dataIndex: 'tier', render: (value: string) => <Tag color={tierColor(value)}>{value}</Tag> },
                  { title: t('Company'), dataIndex: 'company' },
                  { title: t('ASIN'), dataIndex: 'asin' },
                  { title: t('Supplier next action'), key: 'supplierAction', render: (_value: any, row: PlainRecord) => row.supplierName ? row.supplierName : <Tag color="red">{t('Find supplier from OrderDetails')}</Tag> },
                  { title: t('Lead time'), dataIndex: 'leadTimeDays', render: (value: number, row: PlainRecord) => <Space direction="vertical" size={0}><Space size={4}><span>{formatNumber(value)} {t('days')}</span><Tag color={freshnessColor(row.leadTimeFreshness)}>{t(row.leadTimeFreshness ?? 'unknown')}</Tag></Space><Typography.Text type="secondary">{t(leadTimeSourceText(row))}</Typography.Text></Space> },
                  { title: t('OOS in'), dataIndex: 'estimatedOosDate', render: (value: string) => <Tag color={relativeDateLabel(value, calculationDate).color}>{t(relativeDateLabel(value, calculationDate).label)}</Tag> },
                  { title: t('Money at risk'), dataIndex: 'estimatedProfitRisk', render: (value: number, row: PlainRecord) => <Space direction="vertical" size={0}><Typography.Text strong>{formatCurrency(value)}</Typography.Text><Typography.Text type="secondary">{t(monetaryRiskText(row))}</Typography.Text></Space> },
                  { title: t('Next'), key: 'next', render: (_value: any, row: PlainRecord) => <Button size="small" onClick={(event) => { event.stopPropagation(); setSelectedRow(row); }}>{t('Review')}</Button> },
                ]}
              />
            </Col>
            <Col xs={24} lg={10}>
              <Typography.Title level={5}>{t('Supplier contact priority')}</Typography.Title>
              <Typography.Paragraph type="secondary">{t('Groups urgent rows by supplier. If the supplier is missing, the next action is to recover it from OrderDetails history for that ASIN/company.')}</Typography.Paragraph>
              <Table
                size="small"
                rowKey={(row) => row.supplierName}
                dataSource={digest.sections.suppliersToContactFirst}
                pagination={false}
                columns={[
                  { title: t('Supplier / next action'), dataIndex: 'supplierName', render: (value: string) => value === 'Find supplier from OrderDetails' ? <Tag color="red">{t(value)}</Tag> : value },
                  { title: t('Urgent'), dataIndex: 'urgentCount' },
                  { title: t('A'), dataIndex: 'tierA' },
                  { title: t('B'), dataIndex: 'tierB' },
                  { title: t('C'), dataIndex: 'tierC' },
                  { title: t('Money at risk'), dataIndex: 'estimatedProfitRisk', render: formatCurrency },
                ]}
              />
            </Col>
            <Col xs={24} lg={14}>
              <Typography.Title level={5}>{t('Products needing supplier action')}</Typography.Title>
              <Typography.Paragraph type="secondary">{t('Product-level list across tiers A, B, and C. Review a row to confirm supplier, lead time, order timing, and OOS loss risk.')}</Typography.Paragraph>
              <Table
                size="small"
                rowKey={(row) => row.planningProductId}
                dataSource={digest.sections.supplierActionItems}
                pagination={false}
                onRow={(row) => ({ onClick: () => setSelectedRow(row) })}
                columns={[
                  { title: t('Tier'), dataIndex: 'tier', render: (value: string) => <Tag color={tierColor(value)}>{value}</Tag> },
                  { title: t('ASIN'), dataIndex: 'asin' },
                  { title: t('Supplier'), key: 'supplier', render: (_value: any, row: PlainRecord) => row.supplierName ?? <Tag color="red">{t('Find supplier')}</Tag> },
                  { title: t('Lead'), dataIndex: 'leadTimeDays', render: (value: number, row: PlainRecord) => <Space direction="vertical" size={0}><span>{formatNumber(value)} {t('days')}</span><Typography.Text type="secondary">{t(leadTimeSourceText(row))}</Typography.Text></Space> },
                  { title: t('OOS in'), dataIndex: 'estimatedOosDate', render: (value: string) => <Tag color={relativeDateLabel(value, calculationDate).color}>{t(relativeDateLabel(value, calculationDate).label)}</Tag> },
                  { title: t('Money at risk'), dataIndex: 'estimatedProfitRisk', render: (value: number, row: PlainRecord) => <Space direction="vertical" size={0}><span>{formatCurrency(value)}</span><Typography.Text type="secondary">{t(monetaryRiskText(row))}</Typography.Text></Space> },
                  { title: t('Review'), key: 'review', render: (_value: any, row: PlainRecord) => <Button size="small" onClick={(event) => { event.stopPropagation(); setSelectedRow(row); }}>{t('Review')}</Button> },
                ]}
              />
            </Col>
          </Row>
        </Card>
        <Card title={t('Inventory planning queue')}>
          <Table
            className="ecobase-inventory-table"
            loading={loading}
            rowKey={(row) => row.planningProductId}
            rowClassName={(row) => `ecobase-tier-${row.tier ?? 'unknown'}`}
            dataSource={filteredRows}
            columns={columns}
            size="small"
            scroll={{ x: 2700 }}
            pagination={{ pageSize: 25, showSizeChanger: true }}
            onRow={(row) => ({ onDoubleClick: () => setSelectedRow(row) })}
          />
        </Card>
      </Space>
      <Drawer
        open={!!selectedRow}
        title={selectedRow ? `${selectedRow.asin ?? selectedRow.sku ?? t('Inventory row')} · ${selectedRow.company ?? t('No company')}` : t('Inventory row')}
        width={720}
        onClose={() => setSelectedRow(null)}
        extra={<Button href="/admin/qn3ajc8r0b3" target="_blank">{t('Open editable table')}</Button>}
      >
        {selectedRow ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Alert type="info" showIcon message={t('Recommended next step')} description={t(nextStepFor(selectedRow))} />
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label={t('Action')}><Tag color={actionColor(selectedRow.actionStatus)}>{t(selectedRow.actionStatus ?? 'unknown')}</Tag></Descriptions.Item>
              <Descriptions.Item label={t('Tier')}><Tag color={tierColor(selectedRow.tier)}>{selectedRow.tier}</Tag> {t('Score')} {formatNumber(selectedRow.tierScore)}</Descriptions.Item>
              <Descriptions.Item label={t('Company')}>{selectedRow.company ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('ASIN / SKU')}>{selectedRow.asin ?? '—'} / {selectedRow.sku ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Supplier')}>{selectedRow.supplierName ?? '—'} · {selectedRow.supplierSource ?? '—'} · {selectedRow.supplierConfidence ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Lead time')}>
                <Space direction="vertical" size={0}>
                  <span>{formatNumber(selectedRow.leadTimeDays)} {t('days')} <Tag color={freshnessColor(selectedRow.leadTimeFreshness)}>{t(selectedRow.leadTimeFreshness ?? 'unknown')}</Tag></span>
                  <Typography.Text type="secondary">{t(leadTimeSourceText(selectedRow))}</Typography.Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('Order by')}>{relativeDateLabel(selectedRow.latestSafeReorderDate, calculationDate).label} ({formatDate(selectedRow.latestSafeReorderDate)})</Descriptions.Item>
              <Descriptions.Item label={t('OOS date')}>{relativeDateLabel(selectedRow.estimatedOosDate, calculationDate).label} ({formatDate(selectedRow.estimatedOosDate)})</Descriptions.Item>
              <Descriptions.Item label={t('Suggested quantity')}>{formatNumber(selectedRow.suggestedReorderQty)} · {t('velocity × target days − stock − open orders')}</Descriptions.Item>
              <Descriptions.Item label={t('Money at risk')}>
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{formatCurrency(selectedRow.estimatedProfitRisk)}</Typography.Text>
                  <Typography.Text type="secondary">{t(monetaryRiskText(selectedRow))}</Typography.Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('Stock buckets')}>
                <StockStatus row={selectedRow} t={t} />
              </Descriptions.Item>
              <Descriptions.Item label={t('Order coverage')}>{formatNumber(selectedRow.openOrderCoverageQty)}</Descriptions.Item>
            </Descriptions>
            <Typography.Text type="secondary">
              {t('Use the editable table for record-level review today. The next UI iteration should connect this drawer to the order-management action surface for creating or confirming supplier orders.')}
            </Typography.Text>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
