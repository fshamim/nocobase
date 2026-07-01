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
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FormulaHelp } from '../formula-help';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

const LIFECYCLE_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'contacting', label: 'Contacting' },
  { value: 'product_review', label: 'Product review' },
  { value: 'payment_review', label: 'Payment review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const ACCOUNT_OPTIONS = [
  { value: 'not_started', label: 'Not started' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const PRODUCT_ANALYSIS_OPTIONS = [
  { value: 'not_analyzed', label: 'Not analyzed' },
  { value: 'candidate', label: 'Candidate' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

function unwrapData(response: any): PlainRecord {
  const data = response?.data?.data ?? response?.data ?? {};
  return data?.data ?? data;
}

function unwrapRows(response: any): PlainRecord[] {
  const data = unwrapData(response);
  return Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatCurrency(value: any) {
  const number = Number(value ?? 0);
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(number)
    : '—';
}

function formatDate(value: any) {
  return value ? String(value).slice(0, 10) : '—';
}

function statusColor(value?: string) {
  switch (value) {
    case 'approved':
      return 'green';
    case 'payment_review':
      return 'blue';
    case 'product_review':
      return 'purple';
    case 'contacting':
      return 'orange';
    case 'rejected':
      return 'red';
    default:
      return 'default';
  }
}

function followUpColor(value?: string) {
  switch (value) {
    case 'overdue':
      return 'red';
    case 'due_today':
      return 'volcano';
    case 'scheduled':
      return 'blue';
    default:
      return 'default';
  }
}

function orderStatusColor(value?: string) {
  if (value === 'COMPLETE') return 'green';
  if (value === 'ORDERED' || value === 'INBOUND MONITORING') return 'blue';
  if (value === 'ORDER ANALYSING' || value === 'APPROVED TO ORDER') return 'orange';
  return 'default';
}

export default function SupplierManagementPage() {
  const api = useAPIClient();
  const t = useT();
  const { message } = App.useApp();
  const [calculationDate, setCalculationDate] = useState(todayIso());
  const [company, setCompany] = useState('');
  const [rows, setRows] = useState<PlainRecord[]>([]);
  const [summary, setSummary] = useState<PlainRecord>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<PlainRecord | null>(null);
  const [detail, setDetail] = useState<PlainRecord>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [productOptions, setProductOptions] = useState<PlainRecord[]>([]);
  const [createDraft, setCreateDraft] = useState<PlainRecord>({ approvalStatus: 'new' });
  const [statusDraft, setStatusDraft] = useState('contacting');
  const [commentDraft, setCommentDraft] = useState('');
  const [followUpDraft, setFollowUpDraft] = useState<string | undefined>();
  const [accountDraft, setAccountDraft] = useState<PlainRecord>({ status: 'approved', orderingMethod: 'email' });
  const [productDraft, setProductDraft] = useState<PlainRecord>({ analysisStatus: 'approved' });
  const [orderDetail, setOrderDetail] = useState<PlainRecord | null>(null);
  const [orderDetailLoading, setOrderDetailLoading] = useState(false);

  const loadDigest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseSupplierManagement:digest',
        method: 'post',
        data: { company: company.trim() || undefined, calculationDate, limit: 1000 },
      });
      const data = unwrapData(response);
      setSummary(data.summary ?? {});
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Supplier digest failed.');
    } finally {
      setLoading(false);
    }
  }, [api, calculationDate, company]);

  const refreshDigest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseSupplierManagement:refreshAttentionRows',
        method: 'post',
        data: { company: company.trim() || undefined, calculationDate, limit: 1000 },
      });
      const data = unwrapData(response);
      setSummary(data.summary ?? {});
      setRows(Array.isArray(data.rows) ? data.rows : []);
      message.success(t('Supplier digest refreshed.'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Supplier digest refresh failed.');
    } finally {
      setLoading(false);
    }
  }, [api, calculationDate, company, message, t]);

  const loadDetail = useCallback(
    async (row: PlainRecord) => {
      if (!row.supplierId) {
        message.warning(t('Resolve this supplier mapping before opening details.'));
        return;
      }
      setSelectedRow(row);
      setDetailLoading(true);
      setDetail({});
      setStatusDraft(row.lifecycleStatus ?? 'contacting');
      setFollowUpDraft(row.nextFollowUpAt);
      try {
        const response = await api.request({
          url: 'ecobaseSupplierManagement:detail',
          method: 'post',
          data: { supplierId: row.supplierId, company: company.trim() || undefined, calculationDate },
        });
        const data = unwrapData(response);
        setDetail(data);
        setStatusDraft(data.supplier?.approvalStatus ?? row.lifecycleStatus ?? 'contacting');
        setFollowUpDraft(data.supplier?.nextFollowUpAt ?? row.nextFollowUpAt);
        setAccountDraft({ status: data.supplier?.accountStatus ?? 'approved', orderingMethod: 'email' });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Supplier detail failed.');
      } finally {
        setDetailLoading(false);
      }
    },
    [api, calculationDate, company, message, t],
  );

  const reloadSelected = useCallback(async () => {
    await loadDigest();
    if (selectedRow?.supplierId) {
      await loadDetail(selectedRow);
    }
  }, [loadDetail, loadDigest, selectedRow]);

  const openOrderDetail = useCallback(
    async (row: PlainRecord) => {
      const orderId = row.orderId ?? row.id;
      if (!orderId) {
        message.warning(t('Order detail is missing the order id.'));
        return;
      }
      setOrderDetailLoading(true);
      setOrderDetail(null);
      try {
        const response = await api.request({
          url: 'ecobaseOrderPlanning:detail',
          method: 'post',
          data: { orderId },
        });
        setOrderDetail(unwrapData(response));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Order detail failed.');
      } finally {
        setOrderDetailLoading(false);
      }
    },
    [api, message, t],
  );

  const createSupplier = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseSupplierManagement:createSupplier',
        method: 'post',
        data: { ...createDraft, company: company.trim() || undefined },
      });
      const supplier = unwrapData(response);
      setCreateOpen(false);
      setCreateDraft({});
      message.success(t('Supplier created.'));
      await loadDigest();
      await loadDetail({
        supplierId: supplier.id,
        lifecycleStatus: supplier.approvalStatus,
        supplierName: supplier.displayName,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Supplier create failed.');
    } finally {
      setSaving(false);
    }
  }, [api, company, createDraft, loadDetail, loadDigest, message, t]);

  const saveLifecycleOrComment = useCallback(async () => {
    const supplierId = detail.supplier?.id ?? selectedRow?.supplierId;
    if (!supplierId) return;
    setSaving(true);
    setError(null);
    try {
      const currentStatus = detail.supplier?.approvalStatus ?? selectedRow?.lifecycleStatus;
      if (statusDraft !== currentStatus) {
        await api.request({
          url: 'ecobaseSupplierManagement:updateSupplierLifecycle',
          method: 'post',
          data: { supplierId, status: statusDraft, comment: commentDraft, followUpAt: followUpDraft },
        });
      } else {
        await api.request({
          url: 'ecobaseSupplierManagement:recordComment',
          method: 'post',
          data: {
            supplierId,
            body: commentDraft || `Follow-up scheduled for ${formatDate(followUpDraft)}.`,
            followUpAt: followUpDraft,
          },
        });
      }
      setCommentDraft('');
      message.success(t('Supplier update logged.'));
      await reloadSelected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Supplier update failed.');
    } finally {
      setSaving(false);
    }
  }, [api, commentDraft, detail.supplier, followUpDraft, message, reloadSelected, selectedRow, statusDraft, t]);

  const saveAccount = useCallback(async () => {
    const supplierId = detail.supplier?.id ?? selectedRow?.supplierId;
    if (!supplierId) return;
    setSaving(true);
    setError(null);
    try {
      await api.request({
        url: 'ecobaseSupplierManagement:updateSupplierAccount',
        method: 'post',
        data: { supplierId, company: company.trim() || undefined, ...accountDraft },
      });
      message.success(t('Supplier account saved.'));
      await reloadSelected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Supplier account save failed.');
    } finally {
      setSaving(false);
    }
  }, [accountDraft, api, company, detail.supplier, message, reloadSelected, selectedRow, t]);

  const loadProductOptions = useCallback(
    async (search?: string) => {
      const response = await api.request({
        url: 'ecobaseSupplierManagement:productOptions',
        method: 'post',
        data: { search, limit: 50 },
      });
      setProductOptions(unwrapRows(response));
    },
    [api],
  );

  const saveProductAnalysis = useCallback(async () => {
    const supplierId = detail.supplier?.id ?? selectedRow?.supplierId;
    if (!supplierId) return;
    setSaving(true);
    setError(null);
    try {
      await api.request({
        url: 'ecobaseSupplierManagement:upsertSupplierProduct',
        method: 'post',
        data: { supplierId, ...productDraft },
      });
      setProductDraft({ analysisStatus: 'approved' });
      message.success(t('Supplier product saved.'));
      await reloadSelected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Supplier product save failed.');
    } finally {
      setSaving(false);
    }
  }, [api, detail.supplier, message, productDraft, reloadSelected, selectedRow, t]);

  const deleteComment = useCallback(
    async (commentId: string) => {
      setSaving(true);
      setError(null);
      try {
        await api.request({ url: 'ecobaseSupplierManagement:deleteComment', method: 'post', data: { commentId } });
        message.success(t('Comment deleted.'));
        await reloadSelected();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Comment delete failed.');
      } finally {
        setSaving(false);
      }
    },
    [api, message, reloadSelected, t],
  );

  useEffect(() => {
    void loadDigest();
  }, [loadDigest]);

  const sortedRows = useMemo(() => [...rows], [rows]);
  const selectedSupplier = detail.supplier ?? {};
  const comments = Array.isArray(detail.comments) ? detail.comments : [];
  const supplierProducts = Array.isArray(detail.supplierProducts) ? detail.supplierProducts : [];
  const inventoryRisks = Array.isArray(detail.inventoryRisks) ? detail.inventoryRisks : [];
  const orderRisks = Array.isArray(detail.orderRisks) ? detail.orderRisks : [];
  const selectedOrder = orderDetail?.order;
  const selectedOrderLines = Array.isArray(orderDetail?.lines) ? orderDetail.lines : [];
  const selectedOrderInvoices = Array.isArray(orderDetail?.invoices) ? orderDetail.invoices : [];
  const selectedOrderComments = Array.isArray(orderDetail?.comments) ? orderDetail.comments : [];

  const columns = [
    {
      title: t('Supplier'),
      dataIndex: 'supplierName',
      width: 210,
      render: (value: string, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          <Typography.Text type="secondary">{row.companyName || t('All companies')}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Lifecycle'),
      dataIndex: 'lifecycleStatus',
      width: 150,
      render: (value: string) => <Tag color={statusColor(value)}>{t(value || 'new')}</Tag>,
    },
    {
      title: t('Follow-up'),
      dataIndex: 'followUpState',
      width: 160,
      render: (value: string, row: PlainRecord) => (
        <Space direction="vertical" size={0}>
          <Tag color={followUpColor(value)}>{t(value || 'missing_follow_up')}</Tag>
          <Typography.Text type="secondary">{formatDate(row.nextFollowUpAt)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('Risk'),
      dataIndex: 'moneyAtRisk',
      width: 130,
      sorter: (left: PlainRecord, right: PlainRecord) => Number(left.moneyAtRisk ?? 0) - Number(right.moneyAtRisk ?? 0),
      render: formatCurrency,
    },
    { title: t('Stale orders'), dataIndex: 'staleOrderCount', width: 110 },
    { title: t('Lead-time issues'), dataIndex: 'leadTimeIssueCount', width: 130 },
    {
      title: t('Products'),
      width: 130,
      render: (_: any, row: PlainRecord) =>
        `${row.approvedProductCount ?? 0} approved / ${row.candidateProductCount ?? 0} review`,
    },
    { title: t('Recommended action'), dataIndex: 'recommendedAction', width: 260 },
    {
      title: t('Last comment'),
      dataIndex: 'lastComment',
      ellipsis: true,
      render: (value: string) => value || <Typography.Text type="secondary">{t('No comment yet')}</Typography.Text>,
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {t('Supplier Management')}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t(
              'Daily supplier digest: contact the highest-risk suppliers, log follow-ups, confirm product fit, and approve payment/account access.',
            )}
          </Typography.Text>
          <Space wrap>
            <DatePicker
              value={dayjs(calculationDate)}
              onChange={(value) => setCalculationDate(value?.format('YYYY-MM-DD') ?? todayIso())}
            />
            <Input
              placeholder={t('Company filter')}
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              style={{ width: 220 }}
            />
            <Button onClick={loadDigest} loading={loading}>
              {t('Load digest')}
            </Button>
            <Button onClick={refreshDigest} loading={loading}>
              {t('Refresh digest')}
            </Button>
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              {t('Add supplier')}
            </Button>
          </Space>
        </Space>
      </Card>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title={t('Contact today')} value={summary.contactToday ?? 0} valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title={t('Overdue follow-ups')} value={summary.overdueFollowUps ?? 0} />
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title={t('Stale order suppliers')} value={summary.staleOrderSuppliers ?? 0} />
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title={t('Lead-time checks')} value={summary.leadTimeIssueSuppliers ?? 0} />
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title={t('Waiting approval')} value={summary.waitingApprovalSuppliers ?? 0} />
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic
              title={t('Money at risk')}
              value={Number(summary.moneyAtRisk ?? 0)}
              formatter={formatCurrency as any}
            />
          </Card>
        </Col>
      </Row>

      <Card title={t('Supplier daily digest')} extra={<FormulaHelp group="supplierDigest" />}>
        <Table
          rowKey={(row) => String(row.naturalKey ?? row.id)}
          loading={loading}
          dataSource={sortedRows}
          columns={columns}
          scroll={{ x: 1400 }}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          onRow={(row) => ({ onClick: () => void loadDetail(row) })}
        />
      </Card>

      <Drawer
        open={Boolean(selectedRow)}
        onClose={() => setSelectedRow(null)}
        width={1040}
        title={selectedSupplier.displayName ?? selectedRow?.supplierName ?? t('Supplier detail')}
        extra={<FormulaHelp group="supplierRisk" />}
      >
        {selectedRow ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            {detailLoading ? <Alert type="info" showIcon message={t('Loading supplier detail...')} /> : null}
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label={t('Lifecycle')}>
                <Tag color={statusColor(selectedSupplier.approvalStatus ?? selectedRow.lifecycleStatus)}>
                  {t(String(selectedSupplier.approvalStatus ?? selectedRow.lifecycleStatus ?? 'new'))}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('Follow-up')}>
                <Tag color={followUpColor(selectedRow.followUpState)}>
                  {t(String(selectedRow.followUpState ?? 'missing_follow_up'))}
                </Tag>{' '}
                {formatDate(selectedSupplier.nextFollowUpAt ?? selectedRow.nextFollowUpAt)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Money at risk')}>
                <Space direction="vertical" size={0}>
                  <Typography.Text>{formatCurrency(selectedRow.moneyAtRisk)}</Typography.Text>
                  <Typography.Text type="secondary">
                    {t('Inventory risk plus active order risk; completed orders are excluded.')}
                  </Typography.Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('Risk split')}>
                {t('Inventory')}: {formatCurrency(selectedRow.inventoryMoneyAtRisk)} · {t('Orders')}:{' '}
                {formatCurrency(selectedRow.orderMoneyAtRisk)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Recommended action')}>
                {selectedRow.recommendedAction ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Contact')} span={2}>
                {[
                  selectedSupplier.contactName,
                  selectedSupplier.email,
                  selectedSupplier.phone,
                  selectedSupplier.website,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Last comment')} span={2}>
                {detail.latestComment?.body ?? selectedRow.lastComment ?? t('No comment yet')}
              </Descriptions.Item>
            </Descriptions>

            <Card title={t('Quick log status / follow-up')} size="small">
              <Row gutter={[12, 12]}>
                <Col xs={24} md={8}>
                  <Typography.Text>{t('Lifecycle status')}</Typography.Text>
                  <Select
                    style={{ width: '100%' }}
                    options={LIFECYCLE_OPTIONS}
                    value={statusDraft}
                    onChange={setStatusDraft}
                  />
                </Col>
                <Col xs={24} md={8}>
                  <Typography.Text>{t('Next follow-up')}</Typography.Text>
                  <DatePicker
                    style={{ width: '100%' }}
                    value={followUpDraft ? dayjs(followUpDraft) : undefined}
                    onChange={(value) => setFollowUpDraft(value?.toISOString())}
                  />
                </Col>
                <Col xs={24} md={8} style={{ display: 'flex', alignItems: 'end' }}>
                  <Button type="primary" loading={saving} onClick={saveLifecycleOrComment}>
                    {t('Log supplier update')}
                  </Button>
                </Col>
                <Col span={24}>
                  <Input.TextArea
                    rows={3}
                    placeholder={t(
                      'What happened? Last response, promised product list, payment status, or next action.',
                    )}
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                  />
                </Col>
              </Row>
            </Card>

            <Row gutter={[16, 16]}>
              <Col xs={24} lg={12}>
                <Card title={t('Product fit')} size="small">
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Select
                      showSearch
                      placeholder={t('Search ASIN, SKU, or title')}
                      filterOption={false}
                      onFocus={() => void loadProductOptions()}
                      onSearch={(value) => void loadProductOptions(value)}
                      options={productOptions.map((option) => ({ value: option.value, label: option.label }))}
                      value={productDraft.productId}
                      onChange={(value) => setProductDraft((draft) => ({ ...draft, productId: value }))}
                    />
                    <Space.Compact style={{ width: '100%' }}>
                      <Input
                        placeholder={t('Supplier SKU')}
                        value={productDraft.supplierSku}
                        onChange={(event) =>
                          setProductDraft((draft) => ({ ...draft, supplierSku: event.target.value }))
                        }
                      />
                      <Select
                        style={{ width: 170 }}
                        options={PRODUCT_ANALYSIS_OPTIONS}
                        value={productDraft.analysisStatus}
                        onChange={(value) => setProductDraft((draft) => ({ ...draft, analysisStatus: value }))}
                      />
                    </Space.Compact>
                    <Space>
                      <InputNumber
                        min={0}
                        placeholder={t('Unit cost')}
                        value={productDraft.unitCost}
                        onChange={(value) => setProductDraft((draft) => ({ ...draft, unitCost: value }))}
                      />
                      <InputNumber
                        min={1}
                        placeholder={t('Lead time days')}
                        value={productDraft.leadTimeDays}
                        onChange={(value) => setProductDraft((draft) => ({ ...draft, leadTimeDays: value }))}
                      />
                      <Button loading={saving} onClick={saveProductAnalysis}>
                        {t('Save product fit')}
                      </Button>
                    </Space>
                  </Space>
                </Card>
              </Col>
              <Col xs={24} lg={12}>
                <Card title={t('Payment / account access')} size="small">
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Input
                      placeholder={t('Account name')}
                      value={accountDraft.accountName}
                      onChange={(event) => setAccountDraft((draft) => ({ ...draft, accountName: event.target.value }))}
                    />
                    <Space.Compact style={{ width: '100%' }}>
                      <Select
                        style={{ width: 180 }}
                        options={ACCOUNT_OPTIONS}
                        value={accountDraft.status}
                        onChange={(value) => setAccountDraft((draft) => ({ ...draft, status: value }))}
                      />
                      <Input
                        placeholder={t('Portal URL or payment note')}
                        value={accountDraft.portalUrl}
                        onChange={(event) => setAccountDraft((draft) => ({ ...draft, portalUrl: event.target.value }))}
                      />
                    </Space.Compact>
                    <Button loading={saving} onClick={saveAccount}>
                      {t('Save account status')}
                    </Button>
                  </Space>
                </Card>
              </Col>
            </Row>

            <Card title={t('Supplier products')} size="small">
              <Table
                rowKey={(row) => String(row.id)}
                size="small"
                pagination={false}
                dataSource={supplierProducts}
                columns={[
                  { title: t('ASIN'), dataIndex: 'asin' },
                  { title: t('SKU'), dataIndex: 'sku' },
                  { title: t('Title'), dataIndex: 'title', ellipsis: true },
                  {
                    title: t('Analysis'),
                    dataIndex: 'analysisStatus',
                    render: (value: string) => <Tag>{t(value || 'not_analyzed')}</Tag>,
                  },
                  { title: t('Lead time'), dataIndex: 'leadTimeDays' },
                ]}
              />
            </Card>

            <Card title={t('Risk drivers')} size="small" extra={<FormulaHelp group="supplierRisk" />}>
              <Row gutter={[16, 16]}>
                <Col xs={24} lg={12}>
                  <Typography.Text strong>{t('Inventory / lead-time risk')}</Typography.Text>
                  <Table
                    rowKey={(row) => String(row.id ?? `${row.asin}:${row.sku}`)}
                    size="small"
                    pagination={{ pageSize: 5 }}
                    dataSource={inventoryRisks}
                    columns={[
                      { title: t('ASIN'), dataIndex: 'asin' },
                      { title: t('SKU'), dataIndex: 'sku' },
                      { title: t('Risk'), dataIndex: 'estimatedProfitRisk', render: formatCurrency },
                      { title: t('Lead time'), dataIndex: 'leadTimeFreshness' },
                    ]}
                  />
                </Col>
                <Col xs={24} lg={12}>
                  <Typography.Text strong>{t('Active stalled orders')}</Typography.Text>
                  <Table
                    rowKey={(row) => String(row.orderId ?? row.id ?? row.orderRef)}
                    size="small"
                    pagination={{ pageSize: 5 }}
                    dataSource={orderRisks}
                    onRow={(row) => ({ onClick: () => void openOrderDetail(row) })}
                    columns={[
                      { title: t('Order'), dataIndex: 'orderRef' },
                      {
                        title: t('Status'),
                        dataIndex: 'currentStatus',
                        render: (value: string) => <Tag color={orderStatusColor(value)}>{value || '—'}</Tag>,
                      },
                      { title: t('Waiting days'), dataIndex: 'daysSinceLastActivity' },
                      { title: t('Risk'), dataIndex: 'moneyAtRisk', render: formatCurrency },
                    ]}
                  />
                </Col>
              </Row>
            </Card>

            <Card title={t('Comments / follow-ups')} size="small">
              <Table
                rowKey={(row) => String(row.id)}
                size="small"
                dataSource={comments}
                pagination={{ pageSize: 5 }}
                columns={[
                  { title: t('When'), dataIndex: 'createdAt', width: 120, render: formatDate },
                  {
                    title: t('Type'),
                    dataIndex: 'commentType',
                    width: 140,
                    render: (value: string) => <Tag>{t(value || 'note')}</Tag>,
                  },
                  { title: t('Comment'), dataIndex: 'body' },
                  { title: t('Follow-up'), dataIndex: 'followUpAt', width: 130, render: formatDate },
                  {
                    title: t('Action'),
                    width: 90,
                    render: (_: any, row: PlainRecord) => (
                      <Button size="small" danger loading={saving} onClick={() => void deleteComment(String(row.id))}>
                        {t('Delete')}
                      </Button>
                    ),
                  },
                ]}
              />
            </Card>
          </Space>
        ) : null}
      </Drawer>

      <Drawer
        open={Boolean(orderDetail) || orderDetailLoading}
        width={920}
        title={selectedOrder ? `${selectedOrder.orderRef} · ${selectedOrder.supplierName}` : t('Order detail')}
        onClose={() => setOrderDetail(null)}
      >
        {selectedOrder ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label={t('Order ref')}>{selectedOrder.orderRef}</Descriptions.Item>
              <Descriptions.Item label={t('Company')}>{selectedOrder.companyName}</Descriptions.Item>
              <Descriptions.Item label={t('Supplier')}>{selectedOrder.supplierName}</Descriptions.Item>
              <Descriptions.Item label={t('Status')}>
                <Tag color={orderStatusColor(selectedOrder.currentStatus)}>{selectedOrder.currentStatus || '—'}</Tag>
                {selectedOrder.statusCheckRequired ? <Tag color="red">{t('needs status check')}</Tag> : null}
              </Descriptions.Item>
              <Descriptions.Item label={t('Status source')}>{selectedOrder.statusSource || '—'}</Descriptions.Item>
              <Descriptions.Item label={t('Money at risk')}>
                {formatCurrency(selectedOrder.moneyAtRisk)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Waiting')}>{selectedOrder.daysSinceLastActivity ?? '—'}d</Descriptions.Item>
              <Descriptions.Item label={t('Expected delivery')}>
                {formatDate(selectedOrder.expectedDeliveryDate)}
              </Descriptions.Item>
              <Descriptions.Item label={t('Next action')} span={2}>
                {selectedOrder.nextAction || '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('Latest comment')} span={2}>
                {selectedOrder.latestComment || '—'}
              </Descriptions.Item>
            </Descriptions>

            <Card title={t('Order lines')} size="small">
              <Table
                rowKey={(row) => String(row.id)}
                size="small"
                pagination={{ pageSize: 5 }}
                dataSource={selectedOrderLines}
                columns={[
                  { title: t('ASIN'), dataIndex: 'asin' },
                  { title: t('SKU'), dataIndex: 'sku' },
                  { title: t('Title'), dataIndex: 'title', ellipsis: true },
                  { title: t('Ordered'), dataIndex: 'orderedQty' },
                  { title: t('Received'), dataIndex: 'receivedQty' },
                  { title: t('Expected profit'), dataIndex: 'expectedProfit', render: formatCurrency },
                ]}
              />
            </Card>

            {selectedOrderInvoices.length ? (
              <Card title={t('Invoices')} size="small">
                <Table
                  rowKey={(row) => String(row.id)}
                  size="small"
                  pagination={false}
                  dataSource={selectedOrderInvoices}
                  columns={[
                    { title: t('Invoice'), dataIndex: 'invoiceNumber' },
                    { title: t('Status'), dataIndex: 'status' },
                    { title: t('Amount'), dataIndex: 'amount', render: formatCurrency },
                    { title: t('Paid at'), dataIndex: 'paidAt', render: formatDate },
                  ]}
                />
              </Card>
            ) : null}

            <Card title={t('Comments')} size="small">
              <Table
                rowKey={(row) => String(row.id)}
                size="small"
                pagination={{ pageSize: 5 }}
                dataSource={selectedOrderComments}
                columns={[
                  { title: t('When'), dataIndex: 'createdAt', width: 120, render: formatDate },
                  { title: t('Type'), dataIndex: 'commentType', width: 140 },
                  { title: t('Comment'), dataIndex: 'body' },
                ]}
              />
            </Card>
          </Space>
        ) : orderDetailLoading ? (
          <Typography.Text>{t('Loading order detail…')}</Typography.Text>
        ) : null}
      </Drawer>

      <Modal
        open={createOpen}
        title={t('Add supplier')}
        onCancel={() => setCreateOpen(false)}
        onOk={createSupplier}
        confirmLoading={saving}
        okText={t('Create supplier')}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            placeholder={t('Supplier name')}
            value={createDraft.name}
            onChange={(event) => setCreateDraft((draft) => ({ ...draft, name: event.target.value }))}
          />
          <Input
            placeholder={t('Contact person')}
            value={createDraft.contactName}
            onChange={(event) => setCreateDraft((draft) => ({ ...draft, contactName: event.target.value }))}
          />
          <Input
            placeholder={t('Email')}
            value={createDraft.email}
            onChange={(event) => setCreateDraft((draft) => ({ ...draft, email: event.target.value }))}
          />
          <Input
            placeholder={t('Phone')}
            value={createDraft.phone}
            onChange={(event) => setCreateDraft((draft) => ({ ...draft, phone: event.target.value }))}
          />
          <DatePicker
            style={{ width: '100%' }}
            placeholder={t('First follow-up date')}
            value={createDraft.nextFollowUpAt ? dayjs(createDraft.nextFollowUpAt) : undefined}
            onChange={(value) => setCreateDraft((draft) => ({ ...draft, nextFollowUpAt: value?.toISOString() }))}
          />
          <Input.TextArea
            rows={3}
            placeholder={t('Initial note')}
            value={createDraft.notes}
            onChange={(event) => setCreateDraft((draft) => ({ ...draft, notes: event.target.value }))}
          />
        </Space>
      </Modal>
    </Space>
  );
}
