import { useAPIClient } from '@nocobase/client';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;
type AttentionFilter =
  | 'all'
  | 'urgent'
  | 'needs_attention'
  | 'lead_time_issues'
  | 'delayed_orders'
  | 'overdue_followup';

const SUPPLIER_TEXT_FIELDS = [
  ['name', 'Supplier Name'],
  ['supplierId', 'SR ID'],
  ['asin', 'ASIN'],
  ['reachedVia', 'Reached Via'],
  ['receivedEmail', 'Received Email'],
  ['contactName', 'Contact Person'],
  ['designation', 'Designation'],
  ['supplierType', 'Supplier Type'],
  ['presenceOnAmazon', 'Presence on Amazon'],
  ['currentStatus', 'Current Status'],
  ['supplierStatus', 'Status'],
  ['activeStatus', 'Active Status'],
  ['emailDone', 'Email Done?'],
  ['callDone', 'Call Done?'],
  ['prPortalLink', 'PR Portal Link'],
  ['wholesalePriceList', 'Wholesale Price List'],
  ['moq', 'MOQ'],
  ['dateOfUpdate', 'Date of Update'],
] as const;

const SUPPLIER_STATUS_FIELDS = [
  [
    'approvalStatus',
    'Approval Status',
    [
      ['new', 'New'],
      ['contacting', 'Contacting'],
      ['analyzing', 'Analyzing'],
      ['approved', 'Approved'],
      ['rejected', 'Rejected'],
    ],
  ],
  [
    'accountStatus',
    'Account Status',
    [
      ['not_started', 'Not started'],
      ['submitted', 'Submitted'],
      ['approved', 'Approved'],
      ['rejected', 'Rejected'],
    ],
  ],
  [
    'analysisStatus',
    'Analysis Status',
    [
      ['not_started', 'Not started'],
      ['in_progress', 'In progress'],
      ['done', 'Done'],
    ],
  ],
] as const;

const SUPPLIER_SELECT_FIELDS: Record<string, string[]> = {
  activeStatus: ['Yes', 'No'],
  emailDone: ['Yes', 'No'],
  callDone: ['Yes', 'No'],
  supplierType: ['Brand Approved', 'Distributor Approved'],
  presenceOnAmazon: ['Excellent', 'Good', 'Average', 'Poor'],
  currentStatus: ['Active', 'Inactive', 'Unknown'],
  supplierStatus: ['Approved', 'Completed', 'In Progress', 'Rejected', 'Cancelled'],
};

const SUPPLIER_TEXTAREA_FIELDS = [
  ['remarks', 'Remarks'],
  ['approvalNotes', 'Approval Notes'],
] as const;

const SUPPLIER_NUMBER_FIELDS = [] as const;

interface SupplierProfileForm extends PlainRecord {
  active: boolean;
  activityNotes: string;
}

interface ContactForm {
  notes: string;
  nextFollowUpAt?: string;
  contactEstablished: boolean;
}

interface LeadTimeDraft {
  productOptionValue?: string;
  planningProductId?: string;
  asin?: string;
  sku?: string;
  leadTimeDays?: number;
  notes: string;
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

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function asText(value: any) {
  return typeof value === 'string' ? value : '';
}

function formatNumber(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
}

function formatCurrency(value: any) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—';
}

function formatDate(value: any) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 10) : '—';
}

function isStaleLeadTime(value: any) {
  return typeof value === 'string' && value ? dayjs().diff(dayjs(value), 'day') > 60 : false;
}

function statusColor(value?: string) {
  switch (value) {
    case 'urgent':
      return 'red';
    case 'needs_attention':
      return 'orange';
    case 'monitor':
      return 'gold';
    case 'ok':
      return 'green';
    default:
      return 'default';
  }
}

function contactColor(value?: string) {
  switch (value) {
    case 'overdue':
      return 'red';
    case 'due':
      return 'orange';
    case 'fresh':
      return 'green';
    case 'missing':
      return 'default';
    default:
      return 'default';
  }
}

function reasonLabels(row: PlainRecord) {
  const reasonCodes = Array.isArray(row.reasonCodes) ? row.reasonCodes : [];
  return reasonCodes.slice(0, 4).map((reason: string) => <Tag key={reason}>{reason.replaceAll('_', ' ')}</Tag>);
}

function rowHasLeadTimeIssue(row: PlainRecord) {
  return Number(row.leadTimeIssueCount ?? 0) > 0;
}

function rowHasDelayedOrder(row: PlainRecord) {
  return Number(row.blockedOpenOrderCount ?? 0) > 0 || Number(row.lateOpenOrderCount ?? 0) > 0;
}

function supplierProfileFromRecord(supplier: PlainRecord): SupplierProfileForm {
  const form: SupplierProfileForm = {
    active: supplier.active !== false,
    activityNotes: '',
    contactEstablished: supplier.contactEstablished === true,
    nextFollowUpAt: asText(supplier.nextFollowUpAt),
    lastContactedAt: asText(supplier.lastContactedAt),
  };
  for (const [field] of SUPPLIER_STATUS_FIELDS) form[field] = asText(supplier[field]);
  for (const [field] of SUPPLIER_TEXT_FIELDS) form[field] = asText(supplier[field]);
  for (const [field] of SUPPLIER_TEXTAREA_FIELDS) form[field] = asText(supplier[field]);
  for (const [field] of SUPPLIER_NUMBER_FIELDS) form[field] = supplier[field] ?? null;
  return form;
}

function leadTimeRowKey(row: PlainRecord) {
  return String(row.id ?? row.naturalKey ?? `${row.scope}:${row.planningProductId ?? row.asin ?? 'default'}`);
}

export default function SupplierManagementPage() {
  const api = useAPIClient();
  const { message } = App.useApp();
  const t = useT();
  const [company, setCompany] = useState('');
  const [companyOptions, setCompanyOptions] = useState<string[]>([]);
  const [calculationDate, setCalculationDate] = useState(todayIsoDate());
  const [quickFilter, setQuickFilter] = useState<AttentionFilter>('all');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<PlainRecord[]>([]);
  const [summary, setSummary] = useState<PlainRecord>({});
  const [selectedRow, setSelectedRow] = useState<PlainRecord | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PlainRecord>({});
  const [supplierForm, setSupplierForm] = useState<SupplierProfileForm>(() => supplierProfileFromRecord({}));
  const [contactForm, setContactForm] = useState<ContactForm>({ notes: '', contactEstablished: true });
  const [leadTimeEdits, setLeadTimeEdits] = useState<Record<string, LeadTimeDraft>>({});
  const [defaultLeadTime, setDefaultLeadTime] = useState<LeadTimeDraft>({ notes: '' });
  const [productLeadTime, setProductLeadTime] = useState<LeadTimeDraft>({ notes: '' });
  const [productOptions, setProductOptions] = useState<PlainRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const selectedSupplier = selectedDetail.supplier ?? {};
  const selectedSupplierId = String(selectedSupplier.id ?? selectedRow?.supplierId ?? '');
  const selectedCompany = String(selectedSupplier.company ?? selectedRow?.company ?? '');

  const loadProductOptions = useCallback(
    async (searchValue = '') => {
      if (!selectedCompany) return;
      const response = await api.request({
        url: 'ecobaseSupplierManagement:productOptions',
        method: 'post',
        data: { company: selectedCompany, search: searchValue, limit: 25 },
      });
      setProductOptions(unwrapRows(response));
    },
    [api, selectedCompany],
  );

  const loadSupplierAttention = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = {
        company: company.trim() || undefined,
        calculationDate: calculationDate.trim() || undefined,
        limit: 1000,
      };
      const [summaryResponse, rowsResponse] = await Promise.all([
        api.request({ url: 'ecobaseSupplierManagement:summary', method: 'post', data: payload }),
        api.request({ url: 'ecobaseSupplierManagement:rows', method: 'post', data: payload }),
      ]);
      const nextRows = unwrapRows(rowsResponse);
      setSummary(unwrapData(summaryResponse));
      setRows(nextRows);
      setCompanyOptions((existing) =>
        [...new Set([...existing, ...nextRows.map((row) => asText(row.company)).filter(Boolean)])].sort(),
      );
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, calculationDate, company]);

  const loadSupplierDetail = useCallback(
    async (row: PlainRecord) => {
      const supplierId = String(row.supplierId ?? '');
      const rowCompany = String(row.company ?? '');
      if (!supplierId || !rowCompany) {
        throw new Error('Ecobase supplier detail failed: supplierId and company are required from the selected row.');
      }
      setDetailLoading(true);
      setError(null);
      try {
        const response = await api.request({
          url: 'ecobaseSupplierManagement:detail',
          method: 'post',
          data: { company: rowCompany, supplierId, calculationDate },
        });
        const detail = unwrapData(response);
        setSelectedDetail(detail);
        setSupplierForm(supplierProfileFromRecord(detail.supplier ?? {}));
        setContactForm({ notes: '', nextFollowUpAt: undefined, contactEstablished: true });
        setLeadTimeEdits({});
        setDefaultLeadTime({ notes: '' });
        setProductLeadTime({ notes: '' });
      } catch (err) {
        setError(err as Error);
      } finally {
        setDetailLoading(false);
      }
    },
    [api, calculationDate],
  );

  const openSupplier = useCallback(
    (row: PlainRecord) => {
      setSelectedRow(row);
      void loadSupplierDetail(row);
    },
    [loadSupplierDetail],
  );

  const refreshAttentionRows = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseSupplierManagement:refreshAttentionRows',
        method: 'post',
        data: {
          company: company.trim() || undefined,
          calculationDate: calculationDate.trim() || undefined,
          limit: 1000,
        },
      });
      const result = unwrapData(response);
      message.success(
        t('Supplier attention refreshed: {{count}} rows', { count: formatNumber(result.refreshedCount) }),
      );
      await loadSupplierAttention();
      if (selectedRow) {
        await loadSupplierDetail(selectedRow);
      }
    } catch (err) {
      setError(err as Error);
    } finally {
      setRefreshing(false);
    }
  }, [api, calculationDate, company, loadSupplierAttention, loadSupplierDetail, message, selectedRow, t]);

  const saveSupplierProfile = useCallback(async () => {
    if (!selectedCompany || !selectedSupplierId) return;
    setSaving(true);
    setError(null);
    try {
      await api.request({
        url: 'ecobaseSupplierManagement:updateSupplierProfile',
        method: 'post',
        data: {
          company: selectedCompany,
          supplierId: selectedSupplierId,
          ...supplierForm,
        },
      });
      message.success(t('Supplier details saved.'));
      if (selectedRow) await loadSupplierDetail(selectedRow);
      await loadSupplierAttention();
    } catch (err) {
      setError(err as Error);
    } finally {
      setSaving(false);
    }
  }, [
    api,
    loadSupplierAttention,
    loadSupplierDetail,
    message,
    selectedCompany,
    selectedRow,
    selectedSupplierId,
    supplierForm,
    t,
  ]);

  const recordSupplierContact = useCallback(async () => {
    if (!selectedCompany || !selectedSupplierId) return;
    setSaving(true);
    setError(null);
    try {
      await api.request({
        url: 'ecobaseSupplierManagement:recordActivity',
        method: 'post',
        data: {
          company: selectedCompany,
          supplierId: selectedSupplierId,
          activityType: 'contacted_supplier',
          notes: contactForm.notes || undefined,
          nextFollowUpAt: contactForm.nextFollowUpAt,
          contactEstablished: contactForm.contactEstablished,
        },
      });
      message.success(t('Supplier contact recorded.'));
      setContactForm({ notes: '', nextFollowUpAt: undefined, contactEstablished: true });
      if (selectedRow) await loadSupplierDetail(selectedRow);
      await refreshAttentionRows();
    } catch (err) {
      setError(err as Error);
    } finally {
      setSaving(false);
    }
  }, [
    api,
    contactForm,
    message,
    refreshAttentionRows,
    selectedCompany,
    selectedRow,
    selectedSupplierId,
    loadSupplierDetail,
    t,
  ]);

  const saveLeadTime = useCallback(
    async (draft: LeadTimeDraft & { asin?: string; sku?: string }) => {
      if (!selectedCompany || !selectedSupplierId || typeof draft.leadTimeDays !== 'number') return;
      setSaving(true);
      setError(null);
      try {
        await api.request({
          url: 'ecobaseSupplierManagement:updateSupplierProductLeadTime',
          method: 'post',
          data: {
            company: selectedCompany,
            supplierId: selectedSupplierId,
            planningProductId: draft.planningProductId,
            asin: draft.asin,
            sku: draft.sku,
            leadTimeDays: draft.leadTimeDays,
            confirmedAt: new Date().toISOString(),
            notes: draft.notes || undefined,
          },
        });
        message.success(t('Lead time saved.'));
        if (selectedRow) await loadSupplierDetail(selectedRow);
        await refreshAttentionRows();
      } catch (err) {
        setError(err as Error);
      } finally {
        setSaving(false);
      }
    },
    [api, loadSupplierDetail, message, refreshAttentionRows, selectedCompany, selectedRow, selectedSupplierId, t],
  );

  useEffect(() => {
    void loadSupplierAttention();
  }, [loadSupplierAttention]);

  useEffect(() => {
    if (selectedRow) {
      void loadProductOptions();
    }
  }, [loadProductOptions, selectedRow]);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((left, right) => {
        const riskDiff = Number(right.totalEstimatedProfitRisk ?? 0) - Number(left.totalEstimatedProfitRisk ?? 0);
        if (riskDiff !== 0) return riskDiff;
        return Number(right.attentionScore ?? 0) - Number(left.attentionScore ?? 0);
      }),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sortedRows.filter((row) => {
      if (quickFilter === 'urgent' && row.attentionStatus !== 'urgent') return false;
      if (quickFilter === 'needs_attention' && !['urgent', 'needs_attention'].includes(String(row.attentionStatus))) {
        return false;
      }
      if (quickFilter === 'lead_time_issues' && !rowHasLeadTimeIssue(row)) return false;
      if (quickFilter === 'delayed_orders' && !rowHasDelayedOrder(row)) return false;
      if (quickFilter === 'overdue_followup' && row.contactStatus !== 'overdue') return false;
      if (!needle) return true;
      return [row.supplierName, row.company, row.recommendedAction, row.contactStatus]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [quickFilter, search, sortedRows]);

  const topAttentionRows = useMemo(() => filteredRows.slice(0, 5), [filteredRows]);
  const leadTimes = Array.isArray(selectedDetail.leadTimes) ? selectedDetail.leadTimes : [];
  const knownSupplierProducts = Array.isArray(selectedDetail.knownSupplierProducts) ? selectedDetail.knownSupplierProducts : [];
  const atRiskProducts = Array.isArray(selectedDetail.atRiskProducts) ? selectedDetail.atRiskProducts : [];
  const activities = Array.isArray(selectedDetail.activities) ? selectedDetail.activities : [];

  const columns = [
    {
      title: t('Supplier'),
      dataIndex: 'supplierName',
      fixed: 'left' as const,
      width: 240,
      render: (_: unknown, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Button
            type="link"
            style={{ padding: 0 }}
            onClick={(event) => {
              event.stopPropagation();
              openSupplier(row);
            }}
          >
            {String(row.supplierName ?? '—')}
          </Button>
          <Typography.Text type="secondary">{String(row.company ?? '—')}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Approval'),
      dataIndex: 'approvalStatus',
      width: 130,
      render: (value: string) => <Tag>{t(value || 'new')}</Tag>,
    },
    {
      title: t('Profit risk'),
      dataIndex: 'totalEstimatedProfitRisk',
      width: 160,
      align: 'right' as const,
      defaultSortOrder: 'descend' as const,
      sorter: (left: PlainRecord, right: PlainRecord) =>
        Number(left.totalEstimatedProfitRisk ?? 0) - Number(right.totalEstimatedProfitRisk ?? 0),
      render: formatCurrency,
    },
    {
      title: t('Urgency'),
      dataIndex: 'attentionStatus',
      width: 170,
      sorter: (left: PlainRecord, right: PlainRecord) =>
        Number(left.attentionScore ?? 0) - Number(right.attentionScore ?? 0),
      render: (value: string, row: PlainRecord) => (
        <Space direction="vertical" size={4}>
          <Tag color={statusColor(value)}>{t(value || 'unknown')}</Tag>
          <Typography.Text type="secondary">
            {formatNumber(row.attentionScore)} {t('points')}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Recommended action'),
      dataIndex: 'recommendedAction',
      width: 280,
      render: (value: string, row: PlainRecord) => (
        <Space direction="vertical" size={4}>
          <Typography.Text>{value || '—'}</Typography.Text>
          <Space size={0} wrap>
            {reasonLabels(row)}
          </Space>
        </Space>
      ),
    },
    {
      title: t('Risk products'),
      width: 180,
      render: (_: unknown, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>
            {t('Urgent')}: {formatNumber(row.urgentProductCount)}
          </Typography.Text>
          <Typography.Text>
            {t('OOS soon')}: {formatNumber(row.oosSoonProductCount)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Order risk'),
      width: 180,
      render: (_: unknown, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>
            {t('Late')}: {formatNumber(row.lateOpenOrderCount)}
          </Typography.Text>
          <Typography.Text>
            {t('Blocked')}: {formatNumber(row.blockedOpenOrderCount)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Lead-time issues'),
      dataIndex: 'leadTimeIssueCount',
      width: 160,
      render: (_: unknown, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{formatNumber(row.leadTimeIssueCount)}</Typography.Text>
          <Typography.Text type="secondary">
            {t('Missing')}: {formatNumber(row.missingLeadTimeCount)} · {t('Stale')}:{' '}
            {formatNumber(row.staleLeadTimeCount)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Contact soon'),
      dataIndex: 'contactSoon',
      width: 130,
      render: (value: boolean) => (value ? <Tag color="orange">{t('Contact soon')}</Tag> : <Tag>{t('No')}</Tag>),
    },
    {
      title: t('Contact'),
      dataIndex: 'contactStatus',
      width: 170,
      render: (value: string, row: PlainRecord) => (
        <Space direction="vertical" size={4}>
          <Tag color={contactColor(value)}>{t(value || 'unknown')}</Tag>
          <Typography.Text type="secondary">{formatDate(row.lastContactedAt)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Next follow-up'),
      dataIndex: 'nextFollowUpAt',
      width: 140,
      render: formatDate,
    },
    {
      title: t('Earliest OOS'),
      dataIndex: 'earliestEstimatedOosDate',
      width: 130,
      render: formatDate,
    },
  ];

  const leadTimeColumns = [
    {
      title: t('Scope'),
      dataIndex: 'scope',
      width: 110,
      render: (value: string) => <Tag>{t(value || 'default')}</Tag>,
    },
    {
      title: t('Product'),
      width: 220,
      render: (_: unknown, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{row.asin || row.planningProductId || t('General supplier default')}</Typography.Text>
          <Typography.Text type="secondary">{row.sku || row.source || '—'}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Lead time days'),
      width: 190,
      render: (_: unknown, row: PlainRecord) => {
        const key = leadTimeRowKey(row);
        const edit = leadTimeEdits[key] ?? { leadTimeDays: Number(row.leadTimeDays), notes: asText(row.notes) };
        return (
          <InputNumber
            min={1}
            max={3650}
            precision={0}
            value={edit.leadTimeDays}
            onChange={(value) =>
              setLeadTimeEdits((current) => ({ ...current, [key]: { ...edit, leadTimeDays: Number(value) } }))
            }
          />
        );
      },
    },
    {
      title: t('Freshness'),
      dataIndex: 'confirmedAt',
      width: 120,
      render: (value: string) => (isStaleLeadTime(value) ? <Tag color="orange">{t('Stale')}</Tag> : <Tag>{t('Fresh')}</Tag>),
    },
    { title: t('Confirmed'), dataIndex: 'confirmedAt', width: 130, render: formatDate },
    {
      title: t('Notes'),
      width: 220,
      render: (_: unknown, row: PlainRecord) => {
        const key = leadTimeRowKey(row);
        const edit = leadTimeEdits[key] ?? { leadTimeDays: Number(row.leadTimeDays), notes: asText(row.notes) };
        return (
          <Input
            value={edit.notes}
            onChange={(event) =>
              setLeadTimeEdits((current) => ({ ...current, [key]: { ...edit, notes: event.target.value } }))
            }
          />
        );
      },
    },
    {
      title: t('Action'),
      width: 100,
      render: (_: unknown, row: PlainRecord) => {
        const key = leadTimeRowKey(row);
        const edit = leadTimeEdits[key] ?? { leadTimeDays: Number(row.leadTimeDays), notes: asText(row.notes) };
        return (
          <Button
            size="small"
            loading={saving}
            onClick={() =>
              saveLeadTime({
                ...edit,
                planningProductId: row.planningProductId,
                asin: row.asin,
                sku: row.sku,
              })
            }
          >
            {t('Save')}
          </Button>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space direction="vertical" size={4}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('Supplier Management')}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t('Prioritize supplier contact, delayed orders, and lead-time cleanup from the current planning evidence.')}
        </Typography.Text>
      </Space>

      {error ? <Alert type="error" showIcon message={error.message} /> : null}

      <Card>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={4}>
            <Statistic
              title={t('Urgent suppliers')}
              value={summary.urgentSuppliers ?? 0}
              valueStyle={{ color: '#cf1322' }}
            />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Statistic
              title={t('Need attention')}
              value={summary.needsAttentionSuppliers ?? 0}
              valueStyle={{ color: '#d46b08' }}
            />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Statistic title={t('Lead-time issues')} value={summary.leadTimeIssueSuppliers ?? 0} />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Statistic title={t('Delayed / blocked orders')} value={summary.blockedOrLateOpenOrders ?? 0} />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Statistic title={t('Overdue follow-ups')} value={summary.overdueFollowUps ?? 0} />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Statistic
              title={t('Estimated profit risk')}
              value={Number(summary.totalEstimatedProfitRisk ?? 0)}
              precision={0}
              prefix="$"
            />
          </Col>
        </Row>
      </Card>

      {topAttentionRows.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('Suppliers posing the most profit risk')}
          description={
            <Space size={[8, 8]} wrap>
              {topAttentionRows.map((row) => (
                <Tag
                  key={`${row.company}:${row.supplierId}:${row.supplierName}`}
                  color={statusColor(row.attentionStatus)}
                >
                  {row.supplierName} · {row.company} · {formatCurrency(row.totalEstimatedProfitRisk)}
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}

      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input.Search
            allowClear
            placeholder={t('Search supplier, company, action')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ width: 280 }}
          />
          <Select
            allowClear
            showSearch
            placeholder={t('Company')}
            value={company || undefined}
            onChange={(value) => setCompany(value ?? '')}
            style={{ width: 240 }}
            options={companyOptions.map((value) => ({ value, label: value }))}
          />
          <DatePicker
            allowClear={false}
            value={dayjs(calculationDate)}
            onChange={(value) => setCalculationDate(value ? value.format('YYYY-MM-DD') : todayIsoDate())}
          />
          <Select<AttentionFilter>
            value={quickFilter}
            onChange={setQuickFilter}
            style={{ width: 220 }}
            options={[
              { value: 'all', label: t('All suppliers') },
              { value: 'urgent', label: t('Urgent') },
              { value: 'needs_attention', label: t('Needs attention') },
              { value: 'lead_time_issues', label: t('Lead-time issues') },
              { value: 'delayed_orders', label: t('Delayed / blocked orders') },
              { value: 'overdue_followup', label: t('Overdue follow-up') },
            ]}
          />
          <Button onClick={loadSupplierAttention} loading={loading}>
            {t('Load')}
          </Button>
          <Button type="primary" onClick={refreshAttentionRows} loading={refreshing}>
            {t('Refresh attention')}
          </Button>
        </Space>
        <Table
          rowKey={(row) => String(row.id ?? row.naturalKey)}
          loading={loading}
          columns={columns}
          dataSource={filteredRows}
          scroll={{ x: 1600 }}
          pagination={{ pageSize: 25, showSizeChanger: true }}
          onRow={(row) => ({ onClick: () => openSupplier(row) })}
        />
      </Card>

      <Drawer
        open={Boolean(selectedRow)}
        onClose={() => setSelectedRow(null)}
        width={1040}
        title={selectedRow?.supplierName ?? t('Supplier detail')}
      >
        {selectedRow ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            {detailLoading ? <Alert type="info" showIcon message={t('Loading supplier detail...')} /> : null}
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label={t('Company')}>{selectedCompany || '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Status')}>
                <Tag color={statusColor(selectedRow.attentionStatus)}>
                  {t(String(selectedRow.attentionStatus ?? 'unknown'))}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('Recommended action')} span={2}>
                {selectedRow.recommendedAction ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Profit risk')}>
                {formatCurrency(selectedRow.totalEstimatedProfitRisk)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Urgent / OOS soon')}>
                {formatNumber(selectedRow.urgentProductCount)} / {formatNumber(selectedRow.oosSoonProductCount)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Lead-time issues')}>
                {formatNumber(selectedRow.leadTimeIssueCount)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Approval')}>
                <Tag>{t(String(selectedRow.approvalStatus ?? 'new'))}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('Contact soon')}>
                {selectedRow.contactSoon ? <Tag color="orange">{t('Contact soon')}</Tag> : <Tag>{t('No')}</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label={t('Late / blocked orders')}>
                {formatNumber(selectedRow.lateOpenOrderCount)} / {formatNumber(selectedRow.blockedOpenOrderCount)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Reasons')} span={2}>
                <Space size={0} wrap>
                  {reasonLabels(selectedRow)}
                </Space>
              </Descriptions.Item>
            </Descriptions>

            <Card title={t('Recent supplier activity')} size="small">
              <Table
                size="small"
                rowKey={(row) => String(row.id ?? row.naturalKey)}
                dataSource={activities.slice(0, 20)}
                pagination={false}
                columns={[
                  { title: t('When'), dataIndex: 'occurredAt', render: formatDate, width: 120 },
                  {
                    title: t('Type'),
                    dataIndex: 'activityType',
                    width: 160,
                    render: (value: string) => <Tag>{t(value || 'note')}</Tag>,
                  },
                  { title: t('Notes'), dataIndex: 'notes' },
                  { title: t('Next follow-up'), dataIndex: 'nextFollowUpAt', width: 140, render: formatDate },
                ]}
              />
            </Card>

            <Card title={t('Record supplier contact')} size="small">
              <Row gutter={[12, 12]}>
                <Col span={16}>
                  <Typography.Text>{t('Contact outcome / notes')}</Typography.Text>
                  <Input
                    value={contactForm.notes}
                    onChange={(event) => setContactForm((form) => ({ ...form, notes: event.target.value }))}
                  />
                </Col>
                <Col span={4}>
                  <Typography.Text>{t('Contact established')}</Typography.Text>
                  <br />
                  <Switch
                    checked={contactForm.contactEstablished}
                    onChange={(contactEstablished) => setContactForm((form) => ({ ...form, contactEstablished }))}
                  />
                </Col>
                <Col span={4}>
                  <Typography.Text>{t('Next follow-up')}</Typography.Text>
                  <DatePicker
                    style={{ width: '100%' }}
                    value={contactForm.nextFollowUpAt ? dayjs(contactForm.nextFollowUpAt) : undefined}
                    onChange={(value) => setContactForm((form) => ({ ...form, nextFollowUpAt: value?.toISOString() }))}
                  />
                </Col>
                <Col span={24}>
                  <Button loading={saving} onClick={recordSupplierContact}>
                    {t('Record contact')}
                  </Button>
                </Col>
              </Row>
            </Card>

            <Card title={t('General supplier lead time')} size="small">
              <Space wrap>
                <InputNumber
                  min={1}
                  max={3650}
                  precision={0}
                  placeholder={t('Lead time days')}
                  value={defaultLeadTime.leadTimeDays}
                  onChange={(value) => setDefaultLeadTime((draft) => ({ ...draft, leadTimeDays: Number(value) }))}
                />
                <Input
                  style={{ width: 360 }}
                  placeholder={t('Notes')}
                  value={defaultLeadTime.notes}
                  onChange={(event) => setDefaultLeadTime((draft) => ({ ...draft, notes: event.target.value }))}
                />
                <Button type="primary" loading={saving} onClick={() => saveLeadTime(defaultLeadTime)}>
                  {t('Save general lead time')}
                </Button>
              </Space>
            </Card>

            <Card title={t('Product-specific lead times')} size="small">
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space wrap>
                  <Select
                    showSearch
                    allowClear
                    placeholder={t('Product / ASIN')}
                    value={productLeadTime.productOptionValue}
                    onSearch={loadProductOptions}
                    onChange={(value) => {
                      const option = productOptions.find((candidate) => candidate.value === value) ?? {};
                      setProductLeadTime((draft) => ({
                        ...draft,
                        productOptionValue: value,
                        planningProductId: option.planningProductId,
                        asin: option.asin,
                        sku: option.sku,
                      }));
                    }}
                    style={{ width: 360 }}
                    options={productOptions.map((option) => ({ value: option.value, label: option.label }))}
                  />
                  <InputNumber
                    min={1}
                    max={3650}
                    precision={0}
                    placeholder={t('Lead time days')}
                    value={productLeadTime.leadTimeDays}
                    onChange={(value) => setProductLeadTime((draft) => ({ ...draft, leadTimeDays: Number(value) }))}
                  />
                  <Input
                    style={{ width: 280 }}
                    placeholder={t('Notes')}
                    value={productLeadTime.notes}
                    onChange={(event) => setProductLeadTime((draft) => ({ ...draft, notes: event.target.value }))}
                  />
                  <Button type="primary" loading={saving} onClick={() => saveLeadTime(productLeadTime)}>
                    {t('Save product lead time')}
                  </Button>
                </Space>
                <Table
                  size="small"
                  rowKey={leadTimeRowKey}
                  dataSource={leadTimes}
                  columns={leadTimeColumns}
                  pagination={{ pageSize: 8 }}
                  scroll={{ x: 1000 }}
                />
              </Space>
            </Card>

            <Card title={t('At-risk products for this supplier')} size="small">
              <Table
                size="small"
                rowKey={(row) => String(row.id ?? row.planningProductId ?? row.asin)}
                dataSource={atRiskProducts.slice(0, 50)}
                pagination={{ pageSize: 8 }}
                columns={[
                  { title: t('ASIN'), dataIndex: 'asin', width: 130 },
                  { title: t('SKU'), dataIndex: 'sku', width: 130 },
                  {
                    title: t('Action'),
                    dataIndex: 'actionStatus',
                    width: 130,
                    render: (value: string) => <Tag color={statusColor(value)}>{t(value || 'unknown')}</Tag>,
                  },
                  { title: t('OOS date'), dataIndex: 'estimatedOosDate', width: 120, render: formatDate },
                  { title: t('Profit risk'), dataIndex: 'estimatedProfitRisk', width: 120, render: formatCurrency },
                  { title: t('Current lead time'), dataIndex: 'leadTimeDays', width: 140, render: formatNumber },
                  {
                    title: t('Set lead time'),
                    width: 130,
                    render: (_: unknown, row: PlainRecord) => (
                      <Button
                        size="small"
                        onClick={() =>
                          setProductLeadTime({
                            productOptionValue: row.planningProductId
                              ? `planning:${row.planningProductId}`
                              : `history:${row.asin ?? ''}:${row.sku ?? ''}`,
                            planningProductId: asText(row.planningProductId),
                            asin: asText(row.asin),
                            sku: asText(row.sku),
                            leadTimeDays: Number(row.leadTimeDays) || undefined,
                            notes: `Updated from supplier management for ${row.asin ?? row.sku ?? 'product'}`,
                          })
                        }
                      >
                        {t('Use product')}
                      </Button>
                    ),
                  },
                ]}
                scroll={{ x: 1100 }}
              />
            </Card>

            <Card title={t('Historical products ordered from this supplier')} size="small">
              <Table
                size="small"
                rowKey={(row) => `${row.asin ?? ''}:${row.sku ?? ''}`}
                dataSource={knownSupplierProducts.slice(0, 50)}
                pagination={{ pageSize: 8 }}
                columns={[
                  { title: t('ASIN'), dataIndex: 'asin', width: 130 },
                  { title: t('SKU'), dataIndex: 'sku', width: 140 },
                  { title: t('Brand'), dataIndex: 'brand', width: 140 },
                  { title: t('Last ordered'), dataIndex: 'lastOrderedAt', width: 130, render: formatDate },
                  { title: t('Orders'), dataIndex: 'orderCount', width: 90, render: formatNumber },
                  { title: t('Qty'), dataIndex: 'totalOrderedQty', width: 90, render: formatNumber },
                  { title: t('Last cost'), dataIndex: 'lastUnitCost', width: 110, render: formatCurrency },
                  { title: t('Last status'), dataIndex: 'lastOrderStatus', width: 130 },
                  {
                    title: t('Set lead time'),
                    width: 130,
                    render: (_: unknown, row: PlainRecord) => (
                      <Button
                        size="small"
                        onClick={() =>
                          setProductLeadTime({
                            productOptionValue: `history:${row.asin ?? ''}:${row.sku ?? ''}`,
                            asin: asText(row.asin),
                            sku: asText(row.sku),
                            notes: `Updated from supplier management for ${row.asin ?? row.sku ?? 'product'}`,
                          })
                        }
                      >
                        {t('Use product')}
                      </Button>
                    ),
                  },
                ]}
              />
            </Card>


            <Card title={t('Supplier details')} size="small">
              <Row gutter={[12, 12]}>
                <Col span={12}>
                  <Typography.Text>{t('Active')}</Typography.Text>
                  <br />
                  <Switch
                    checked={supplierForm.active}
                    onChange={(active) => setSupplierForm((form) => ({ ...form, active }))}
                  />
                </Col>
                <Col span={12}>
                  <Typography.Text>{t('Save note')}</Typography.Text>
                  <Input
                    value={supplierForm.activityNotes}
                    onChange={(event) => setSupplierForm((form) => ({ ...form, activityNotes: event.target.value }))}
                  />
                </Col>
                {SUPPLIER_STATUS_FIELDS.map(([field, label, options]) => (
                  <Col span={8} key={field}>
                    <Typography.Text>{t(label)}</Typography.Text>
                    <Select
                      style={{ width: '100%' }}
                      value={supplierForm[field]}
                      options={options.map(([value, optionLabel]) => ({ value, label: t(optionLabel) }))}
                      onChange={(value) => setSupplierForm((form) => ({ ...form, [field]: value }))}
                    />
                  </Col>
                ))}
                <Col span={8}>
                  <Typography.Text>{t('Contact established')}</Typography.Text>
                  <br />
                  <Switch
                    checked={supplierForm.contactEstablished === true}
                    onChange={(contactEstablished) => setSupplierForm((form) => ({ ...form, contactEstablished }))}
                  />
                </Col>
                <Col span={8}>
                  <Typography.Text>{t('Next follow-up')}</Typography.Text>
                  <DatePicker
                    style={{ width: '100%' }}
                    value={supplierForm.nextFollowUpAt ? dayjs(supplierForm.nextFollowUpAt) : undefined}
                    onChange={(value) => setSupplierForm((form) => ({ ...form, nextFollowUpAt: value?.toISOString() }))}
                  />
                </Col>
                <Col span={8}>
                  <Typography.Text>{t('Last contacted')}</Typography.Text>
                  <DatePicker
                    style={{ width: '100%' }}
                    value={supplierForm.lastContactedAt ? dayjs(supplierForm.lastContactedAt) : undefined}
                    onChange={(value) => setSupplierForm((form) => ({ ...form, lastContactedAt: value?.toISOString() }))}
                  />
                </Col>
                {SUPPLIER_TEXT_FIELDS.map(([field, label]) => (
                  <Col span={12} key={field}>
                    <Typography.Text>{t(label)}</Typography.Text>
                    {SUPPLIER_SELECT_FIELDS[field] ? (
                      <Select
                        allowClear
                        style={{ width: '100%' }}
                        value={supplierForm[field] || undefined}
                        options={SUPPLIER_SELECT_FIELDS[field].map((value) => ({ value, label: t(value) }))}
                        onChange={(value) => setSupplierForm((form) => ({ ...form, [field]: value }))}
                      />
                    ) : (
                      <Input
                        value={supplierForm[field]}
                        onChange={(event) => setSupplierForm((form) => ({ ...form, [field]: event.target.value }))}
                      />
                    )}
                  </Col>
                ))}
                {SUPPLIER_NUMBER_FIELDS.map(([field, label]) => (
                  <Col span={12} key={field}>
                    <Typography.Text>{t(label)}</Typography.Text>
                    <InputNumber
                      style={{ width: '100%' }}
                      value={supplierForm[field]}
                      onChange={(value) => setSupplierForm((form) => ({ ...form, [field]: value }))}
                    />
                  </Col>
                ))}
                {SUPPLIER_TEXTAREA_FIELDS.map(([field, label]) => (
                  <Col span={24} key={field}>
                    <Typography.Text>{t(label)}</Typography.Text>
                    <Input.TextArea
                      rows={3}
                      value={supplierForm[field]}
                      onChange={(event) => setSupplierForm((form) => ({ ...form, [field]: event.target.value }))}
                    />
                  </Col>
                ))}
                <Col span={24}>
                  <Button type="primary" loading={saving} onClick={saveSupplierProfile}>
                    {t('Save supplier details')}
                  </Button>
                </Col>
              </Row>
            </Card>

          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
