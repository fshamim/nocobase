import { useAPIClient } from '@nocobase/client';
import { Alert, App, Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

interface WorkspaceData {
  reorderCandidates: PlainRecord[];
  supplierOrders: PlainRecord[];
  supplierOrderLines: PlainRecord[];
  supplierProductLinks: PlainRecord[];
  activities: PlainRecord[];
  suppliers: PlainRecord[];
  leadTimes: PlainRecord[];
  rawImportRows: PlainRecord[];
}

function unwrapWorkspace(response: any): WorkspaceData {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || 'reorderCandidates' in data || !('data' in data)) {
      break;
    }
    data = data.data;
  }
  return {
    reorderCandidates: Array.isArray(data?.reorderCandidates) ? data.reorderCandidates : [],
    supplierOrders: Array.isArray(data?.supplierOrders) ? data.supplierOrders : [],
    supplierOrderLines: Array.isArray(data?.supplierOrderLines) ? data.supplierOrderLines : [],
    supplierProductLinks: Array.isArray(data?.supplierProductLinks) ? data.supplierProductLinks : [],
    activities: Array.isArray(data?.activities) ? data.activities : [],
    suppliers: Array.isArray(data?.suppliers) ? data.suppliers : [],
    leadTimes: Array.isArray(data?.leadTimes) ? data.leadTimes : [],
    rawImportRows: Array.isArray(data?.rawImportRows) ? data.rawImportRows : [],
  };
}

function coverageColor(state?: string) {
  switch (state) {
    case 'arrives_before_stockout':
      return 'green';
    case 'arrives_late':
      return 'orange';
    case 'blocked_open_order':
      return 'red';
    case 'incomplete_or_stale':
      return 'gold';
    default:
      return 'default';
  }
}

function openQty(row: PlainRecord) {
  return Math.max(0, Number(row.orderedQty ?? 0) - Number(row.receivedQty ?? 0));
}

export default function OrderManagementPage() {
  const t = useT();
  const api = useAPIClient();
  const { message } = App.useApp();
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState('');
  const [stockoutDate, setStockoutDate] = useState('');
  const [data, setData] = useState<WorkspaceData>(() => unwrapWorkspace({}));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadWorkspace = useCallback(async () => {
    const companyFilter = company.trim();
    if (!companyFilter) {
      setData(unwrapWorkspace({}));
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseSupplierOrders:workspace',
        method: 'post',
        data: {
          company: companyFilter,
          status: status.trim() || undefined,
          stockoutDate: stockoutDate.trim() || undefined,
          limit: 75,
        },
      });
      setData(unwrapWorkspace(response));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, company, status, stockoutDate]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const createPlannedOrder = async (row: PlainRecord) => {
    const qtyText = window.prompt(t('Ordered quantity'), '1');
    if (qtyText === null) {
      return;
    }
    const orderedQty = Number(qtyText);
    const supplierId = window.prompt(t('Supplier ID'), row.preferredSupplierId ?? '');
    if (supplierId === null) {
      return;
    }
    const unitCostText = window.prompt(t('Unit cost'), '') || undefined;
    const expectedDeliveryDate = window.prompt(t('Expected delivery date YYYY-MM-DD'), '') || undefined;
    const expectedSellableDate = window.prompt(t('Expected sellable date YYYY-MM-DD'), '') || undefined;
    await api.request({
      url: 'ecobaseSupplierOrders:createPlannedOrder',
      method: 'post',
      data: {
        company: row.company,
        planningProductId: row.planningProductId,
        supplierId: supplierId.trim() || undefined,
        orderedQty,
        unitCost: unitCostText ? Number(unitCostText) : undefined,
        expectedDeliveryDate,
        expectedSellableDate,
        notes: 'Created from Ecobase order-management workspace.',
      },
    });
    message.success(t('Planned supplier order created'));
    await loadWorkspace();
  };

  const updateOrder = async (row: PlainRecord) => {
    const statusValue = window.prompt(t('Order status'), row.status ?? 'planned');
    if (statusValue === null) {
      return;
    }
    const expectedDeliveryDate = window.prompt(t('Expected delivery date YYYY-MM-DD'), row.expectedDeliveryDate ?? '') || undefined;
    const approvalStatus = window.prompt(t('Approval status'), row.approvalStatus ?? '') || undefined;
    const paymentStatus = window.prompt(t('Payment status'), row.paymentStatus ?? '') || undefined;
    const shippingCarrier = window.prompt(t('Shipping carrier'), row.shippingCarrier ?? '') || undefined;
    const trackingId = window.prompt(t('Tracking reference'), row.trackingId ?? '') || undefined;
    const blockedReason = window.prompt(t('Blocked reason'), row.blockedReason ?? '') || undefined;
    await api.request({
      url: 'ecobaseSupplierOrders:updateOrderOperatorFields',
      method: 'post',
      data: {
        supplierOrderId: row.id,
        company: row.company,
        status: statusValue.trim() || undefined,
        expectedDeliveryDate,
        approvalStatus,
        paymentStatus,
        shippingCarrier,
        trackingId,
        blockedReason,
      },
    });
    message.success(t('Supplier order updated'));
    await loadWorkspace();
  };

  const receiveLine = async (row: PlainRecord) => {
    const receivedQtyText = window.prompt(t('Received quantity'), String(row.receivedQty ?? 0));
    if (receivedQtyText === null) {
      return;
    }
    const planningProductId = window.prompt(t('Planning product ID'), row.planningProductId ?? '') || undefined;
    const orderedQtyText = window.prompt(t('Ordered quantity'), String(row.orderedQty ?? '')) || undefined;
    const unitCostText = window.prompt(t('Unit cost'), String(row.unitCost ?? '')) || undefined;
    const expectedDeliveryDate = window.prompt(t('Expected delivery date YYYY-MM-DD'), row.expectedDeliveryDate ?? '') || undefined;
    const expectedSellableDate = window.prompt(t('Expected sellable date YYYY-MM-DD'), row.expectedSellableDate ?? '') || undefined;
    const notes = window.prompt(t('Line notes'), '') || undefined;
    await api.request({
      url: 'ecobaseSupplierOrders:updateLineOperatorFields',
      method: 'post',
      data: {
        supplierOrderLineId: row.id,
        company: row.company,
        planningProductId,
        orderedQty: orderedQtyText ? Number(orderedQtyText) : undefined,
        receivedQty: Number(receivedQtyText),
        unitCost: unitCostText ? Number(unitCostText) : undefined,
        expectedDeliveryDate,
        expectedSellableDate,
        notes,
      },
    });
    message.success(t('Supplier order line updated'));
    await loadWorkspace();
  };

  const addLine = async (row: PlainRecord) => {
    const planningProductId = window.prompt(t('Planning product ID'), '');
    if (planningProductId === null || !planningProductId.trim()) {
      return;
    }
    const orderedQtyText = window.prompt(t('Ordered quantity'), '1');
    if (orderedQtyText === null) {
      return;
    }
    const unitCostText = window.prompt(t('Unit cost'), '') || undefined;
    const expectedDeliveryDate = window.prompt(t('Expected delivery date YYYY-MM-DD'), '') || undefined;
    const expectedSellableDate = window.prompt(t('Expected sellable date YYYY-MM-DD'), '') || undefined;
    const notes = window.prompt(t('Line notes'), 'Added from Ecobase order-management workspace.') || undefined;
    await api.request({
      url: 'ecobaseSupplierOrders:createOrderLine',
      method: 'post',
      data: {
        supplierOrderId: row.id,
        planningProductId: planningProductId.trim(),
        orderedQty: Number(orderedQtyText),
        unitCost: unitCostText ? Number(unitCostText) : undefined,
        expectedDeliveryDate,
        expectedSellableDate,
        notes,
      },
    });
    message.success(t('Supplier order line added'));
    await loadWorkspace();
  };

  const recordActivity = async (row: PlainRecord, activityType: string) => {
    const notes = window.prompt(t('Activity notes'), '');
    if (notes === null) {
      return;
    }
    const occurredAt = window.prompt(t('Occurred at ISO timestamp'), new Date().toISOString()) || undefined;
    const nextFollowUpAt = window.prompt(t('Next follow-up at ISO timestamp'), '') || undefined;
    const leadTimeDays =
      activityType === 'lead_time_checked' ? Number(window.prompt(t('Confirmed lead time days'), '') ?? NaN) : undefined;
    await api.request({
      url: 'ecobaseSupplierOrders:recordActivity',
      method: 'post',
      data: {
        company: row.company,
        supplierId: row.supplierId,
        supplierOrderId: row.id,
        activityType,
        occurredAt,
        notes,
        nextFollowUpAt,
        leadTimeDays: Number.isFinite(leadTimeDays) ? leadTimeDays : undefined,
      },
    });
    message.success(t('Supplier activity recorded'));
    await loadWorkspace();
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Title level={3}>{t('Ecobase supplier order management')}</Typography.Title>
          <Typography.Paragraph type="secondary">
            {t('Operate normalized supplier orders seeded from the order-management sheets without editing raw import rows.')}
          </Typography.Paragraph>
          <Space wrap>
            <Input placeholder={t('Company filter')} value={company} onChange={(event) => setCompany(event.target.value)} />
            <Input placeholder={t('Status filter')} value={status} onChange={(event) => setStatus(event.target.value)} />
            <Input
              placeholder={t('Projected OOS date YYYY-MM-DD')}
              value={stockoutDate}
              onChange={(event) => setStockoutDate(event.target.value)}
            />
            <Button type="primary" onClick={() => void loadWorkspace()} loading={loading}>
              {t('Refresh workspace')}
            </Button>
          </Space>
          {!company.trim() ? <Alert type="info" message={t('Enter a company filter to load company-scoped order data.')} /> : null}
          {error ? <Alert type="error" message={error.message} /> : null}
        </Space>
      </Card>

      <Card title={t('Reorder candidates and coverage')}>
        <Table<PlainRecord>
          rowKey="planningProductId"
          loading={loading}
          dataSource={data.reorderCandidates}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: t('Company'), dataIndex: 'company', key: 'company' },
            { title: t('ASIN'), dataIndex: 'canonicalAsin', key: 'canonicalAsin' },
            { title: t('Product'), dataIndex: 'title', key: 'title' },
            {
              title: t('Coverage'),
              key: 'coverage',
              render: (_, row) => <Tag color={coverageColor(row.coverage?.coverageState)}>{row.coverage?.coverageState ?? 'unknown'}</Tag>,
            },
            { title: t('Open qty'), dataIndex: 'openQty', key: 'openQty' },
            { title: t('Supplier'), dataIndex: 'preferredSupplierId', key: 'preferredSupplierId' },
            { title: t('Lead time days'), dataIndex: 'leadTimeDays', key: 'leadTimeDays' },
            { title: t('Lead time confirmed'), dataIndex: 'leadTimeConfirmedAt', key: 'leadTimeConfirmedAt' },
            { title: t('Latest contact'), dataIndex: 'latestContactAt', key: 'latestContactAt' },
            {
              title: t('Action'),
              key: 'action',
              render: (_, row) => <Button onClick={() => void createPlannedOrder(row)}>{t('Create planned order')}</Button>,
            },
          ]}
        />
      </Card>

      <Card title={t('Supplier orders')}>
        <Table<PlainRecord>
          rowKey="id"
          loading={loading}
          dataSource={data.supplierOrders}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: t('Order ref'), dataIndex: 'externalOrderRef', key: 'externalOrderRef' },
            { title: t('Company'), dataIndex: 'company', key: 'company' },
            { title: t('Supplier'), dataIndex: 'supplierId', key: 'supplierId' },
            { title: t('Status'), dataIndex: 'status', key: 'status', render: (value) => <Tag>{value}</Tag> },
            { title: t('Expected delivery'), dataIndex: 'expectedDeliveryDate', key: 'expectedDeliveryDate' },
            { title: t('Approval'), dataIndex: 'approvalStatus', key: 'approvalStatus' },
            { title: t('Payment'), dataIndex: 'paymentStatus', key: 'paymentStatus' },
            { title: t('Tracking'), dataIndex: 'trackingId', key: 'trackingId' },
            { title: t('Blocked reason'), dataIndex: 'blockedReason', key: 'blockedReason' },
            {
              title: t('Actions'),
              key: 'actions',
              render: (_, row) => (
                <Space wrap>
                  <Button onClick={() => void updateOrder(row)}>{t('Update order')}</Button>
                  <Button onClick={() => void addLine(row)}>{t('Add line')}</Button>
                  <Button onClick={() => void recordActivity(row, 'contacted_supplier')}>{t('Contacted')}</Button>
                  <Button onClick={() => void recordActivity(row, 'status_update')}>{t('Status update')}</Button>
                  <Button onClick={() => void recordActivity(row, 'lead_time_checked')}>{t('Lead time checked')}</Button>
                  <Button onClick={() => void recordActivity(row, 'note')}>{t('Note')}</Button>
                  <Button onClick={() => void recordActivity(row, 'blocked')}>{t('Blocked')}</Button>
                  <Button onClick={() => void recordActivity(row, 'unblocked')}>{t('Unblocked')}</Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title={t('Supplier order lines')}>
        <Table<PlainRecord>
          rowKey="id"
          loading={loading}
          dataSource={data.supplierOrderLines}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: t('Order ID'), dataIndex: 'supplierOrderId', key: 'supplierOrderId' },
            { title: t('Planning product'), dataIndex: 'planningProductId', key: 'planningProductId' },
            { title: t('ASIN'), dataIndex: 'asin', key: 'asin' },
            { title: t('Ordered'), dataIndex: 'orderedQty', key: 'orderedQty' },
            { title: t('Received'), dataIndex: 'receivedQty', key: 'receivedQty' },
            { title: t('Open'), key: 'openQty', render: (_, row) => openQty(row) },
            { title: t('Unit cost'), dataIndex: 'unitCost', key: 'unitCost' },
            { title: t('Expected delivery'), dataIndex: 'expectedDeliveryDate', key: 'expectedDeliveryDate' },
            { title: t('Expected sellable'), dataIndex: 'expectedSellableDate', key: 'expectedSellableDate' },
            { title: t('Source'), dataIndex: 'sourceStage', key: 'sourceStage' },
            { title: t('Action'), key: 'action', render: (_, row) => <Button onClick={() => void receiveLine(row)}>{t('Receive/update')}</Button> },
          ]}
        />
      </Card>

      <Card title={t('Supplier-product links')}>
        <Table<PlainRecord>
          rowKey="id"
          loading={loading}
          dataSource={data.supplierProductLinks}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: t('Company'), dataIndex: 'company', key: 'company' },
            { title: t('Planning product'), dataIndex: 'planningProductId', key: 'planningProductId' },
            { title: t('Supplier'), dataIndex: 'supplierId', key: 'supplierId' },
            { title: t('Role'), dataIndex: 'role', key: 'role' },
            { title: t('Active'), dataIndex: 'active', key: 'active', render: (value) => <Tag>{String(value)}</Tag> },
            { title: t('Last ordered'), dataIndex: 'lastOrderedAt', key: 'lastOrderedAt' },
          ]}
        />
      </Card>

      <Card title={t('Recent follow-up activity')}>
        <Table<PlainRecord>
          rowKey="id"
          loading={loading}
          dataSource={data.activities}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: t('Occurred'), dataIndex: 'occurredAt', key: 'occurredAt' },
            { title: t('Type'), dataIndex: 'activityType', key: 'activityType' },
            { title: t('Company'), dataIndex: 'company', key: 'company' },
            { title: t('Supplier'), dataIndex: 'supplierId', key: 'supplierId' },
            { title: t('Lead time days'), dataIndex: 'leadTimeDays', key: 'leadTimeDays' },
            { title: t('Next follow-up'), dataIndex: 'nextFollowUpAt', key: 'nextFollowUpAt' },
            { title: t('Notes'), dataIndex: 'notes', key: 'notes' },
          ]}
        />
      </Card>

      <Card title={t('Read-only raw import evidence')}>
        <Table<PlainRecord>
          rowKey="id"
          loading={loading}
          dataSource={data.rawImportRows}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: t('Import run'), dataIndex: 'importRunId', key: 'importRunId' },
            { title: t('Source connection'), dataIndex: 'sourceConnectionId', key: 'sourceConnectionId' },
            { title: t('Row number'), dataIndex: 'rowNumber', key: 'rowNumber' },
            { title: t('Status'), dataIndex: 'status', key: 'status' },
            { title: t('Warnings'), dataIndex: 'warnings', key: 'warnings', render: (value) => JSON.stringify(value ?? []) },
          ]}
        />
      </Card>
    </Space>
  );
}
