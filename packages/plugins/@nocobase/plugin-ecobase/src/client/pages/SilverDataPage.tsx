import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { App, AutoComplete, Button, Card, Drawer, Form, Input, Space, Table, Tag, Typography } from 'antd';
import { useT } from '../locale';
import type { ColumnsType } from 'antd/es/table';

type SilverEntityType =
  | 'product'
  | 'company'
  | 'companyProduct'
  | 'supplier'
  | 'supplierAccount'
  | 'supplierProduct'
  | 'order'
  | 'orderLine'
  | 'invoice'
  | 'inventorySnapshot'
  | 'listingDailyFact'
  | 'task'
  | 'target'
  | 'approval'
  | 'comment';

interface SilverFocus {
  type: SilverEntityType;
  id: string;
}

interface ActiveFocus extends SilverFocus {
  label: string;
}

const LOOKUPS: Array<{ type: SilverEntityType; label: string; placeholder: string }> = [
  { type: 'product', label: 'Product', placeholder: 'SKU / SN, ASIN, or title' },
  { type: 'supplier', label: 'Supplier', placeholder: 'Supplier name or ID' },
  { type: 'order', label: 'Order', placeholder: 'Order ref or tracking ID' },
  { type: 'invoice', label: 'Invoice', placeholder: 'Invoice number' },
  { type: 'company', label: 'Company', placeholder: 'Company name or key' },
];

interface SearchResult extends SilverFocus {
  label: string;
  subtitle: string;
  match: string;
}

interface TableSection {
  key: string;
  title: string;
  type: SilverEntityType;
  fields: string[];
  rows: Record<string, unknown>[];
  highlightIds: string[];
}

interface DrawerData extends SilverFocus {
  title: string;
  record: Record<string, unknown>;
  editableFields: string[];
  comments: Record<string, unknown>[];
}

function unwrap<T>(response: unknown): T {
  let value = (response as { data?: unknown })?.data ?? response;
  while (value && typeof value === 'object' && 'data' in value && Object.keys(value).length === 1) {
    value = (value as { data: unknown }).data;
  }
  return value as T;
}

function display(value: unknown) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function short(value: unknown) {
  const text = display(value);
  return text.length > 64 ? `${text.slice(0, 61)}…` : text;
}

function shortRef(value: unknown) {
  const text = display(value);
  return text === '—' ? text : text.slice(-6);
}

function fieldLabel(field: string) {
  const labels: Record<string, string> = {
    asin: 'ASIN',
    sku: 'SKU / SN',
    productLabel: 'Product',
    companyName: 'Company',
    supplierName: 'Supplier',
    orderLabel: 'Order',
    entityLabel: 'Related item',
    recordRef: 'Ref',
  };
  return labels[field] ?? field.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());
}

function isInternalIdField(field: string) {
  return field === 'id' || field.endsWith('Id') || field.endsWith('Ids');
}

function drawerFields(drawer: DrawerData) {
  const preferred = [
    'productLabel',
    'asin',
    'sku',
    'title',
    'companyName',
    'supplierName',
    'orderLabel',
    'entityLabel',
    'recordRef',
  ];
  const fields = Object.keys(drawer.record).filter(
    (field) => !isInternalIdField(field) && !['createdAt', 'updatedAt'].includes(field),
  );
  return [
    ...preferred.filter((field) => fields.includes(field)),
    ...fields.filter((field) => !preferred.includes(field)),
  ];
}

function optionKey(result: SearchResult) {
  return `${result.type}:${result.id}`;
}

function focusLabel(type: SilverEntityType, row: Record<string, unknown>) {
  const labels: Record<SilverEntityType, unknown> = {
    product: row.productLabel,
    company: row.name,
    companyProduct: row.productLabel,
    supplier: row.displayName ?? row.normalizedName,
    supplierAccount: row.accountName ?? row.supplierName,
    supplierProduct: row.productLabel ?? row.supplierSku,
    order: row.orderLabel,
    orderLine: row.productLabel ?? row.orderLabel,
    invoice: row.invoiceNumber ?? row.orderLabel,
    inventorySnapshot: row.productLabel,
    listingDailyFact: row.productLabel,
    task: row.title,
    target: row.entityLabel ?? row.metric,
    approval: row.title,
    comment: row.body,
  };
  return short(labels[type] || row.recordRef || row.id);
}

export default function SilverDataPage() {
  const t = useT();
  const api = useAPIClient();
  const { message } = App.useApp();
  const [lookupText, setLookupText] = useState<Partial<Record<SilverEntityType, string>>>({});
  const [lookupResults, setLookupResults] = useState<Partial<Record<SilverEntityType, SearchResult[]>>>({});
  const [dateFilter, setDateFilter] = useState<{ from?: string; to?: string }>({});
  const [focus, setFocus] = useState<ActiveFocus | undefined>();
  const [sections, setSections] = useState<TableSection[]>([]);
  const [drawer, setDrawer] = useState<DrawerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [form] = Form.useForm();
  const [commentForm] = Form.useForm();
  const loadSeq = useRef(0);

  const loadContext = useCallback(
    async (nextFocus?: SilverFocus, query?: string) => {
      const seq = ++loadSeq.current;
      const trimmedQuery = query?.trim();
      setLoading(true);
      try {
        const response = await api.request({
          url: 'ecobaseSilverData:context',
          method: 'post',
          data: {
            focus: nextFocus ? { type: nextFocus.type, id: nextFocus.id } : undefined,
            query: trimmedQuery,
            pageSize: nextFocus || trimmedQuery || dateFilter.from || dateFilter.to ? 10000 : 100,
            dateFrom: dateFilter.from,
            dateTo: dateFilter.to,
          },
        });
        if (seq === loadSeq.current) {
          setSections(unwrap<{ sections: TableSection[] }>(response)?.sections ?? []);
        }
      } finally {
        if (seq === loadSeq.current) {
          setLoading(false);
        }
      }
    },
    [api, dateFilter.from, dateFilter.to],
  );

  useEffect(() => {
    void loadContext(focus);
  }, [focus, loadContext]);

  useEffect(() => {
    const active = Object.entries(lookupText).find(([, value]) => value?.trim());
    const type = active?.[0] as SilverEntityType | undefined;
    const query = active?.[1]?.trim() ?? '';
    if (!type || query.length < 2) {
      setLookupResults({});
      return undefined;
    }
    const timeout = window.setTimeout(async () => {
      const response = await api.request({
        url: 'ecobaseSilverData:lookup',
        method: 'post',
        data: { type, query, limit: 20, dateFrom: dateFilter.from, dateTo: dateFilter.to },
      });
      setLookupResults({ [type]: unwrap<SearchResult[]>(response) ?? [] });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [api, dateFilter.from, dateFilter.to, lookupText]);

  const optionsFor = (type: SilverEntityType) =>
    (lookupResults[type] ?? []).map((result) => ({
      value: optionKey(result),
      label: (
        <Space direction="vertical" size={0}>
          <Typography.Text>{result.label}</Typography.Text>
          <Typography.Text type="secondary">
            {result.subtitle} · {result.match}
          </Typography.Text>
        </Space>
      ),
    }));

  const selectFocus = (nextFocus: ActiveFocus) => {
    setFocus(nextFocus);
    setLookupText({});
    setLookupResults({});
  };

  const openDrawer = async (rowFocus: SilverFocus) => {
    setDrawerLoading(true);
    try {
      const response = await api.request({
        url: 'ecobaseSilverData:record',
        method: 'post',
        data: rowFocus,
      });
      const nextDrawer = unwrap<DrawerData>(response);
      setDrawer(nextDrawer);
      form.setFieldsValue(nextDrawer.record);
      commentForm.resetFields();
    } finally {
      setDrawerLoading(false);
    }
  };

  const saveDrawer = async () => {
    if (!drawer) return;
    const values = await form.validateFields();
    const editableValues = Object.fromEntries(
      Object.entries(values).filter(([field]) => drawer.editableFields.includes(field)),
    );
    const response = await api.request({
      url: 'ecobaseSilverData:updateRecord',
      method: 'post',
      data: { type: drawer.type, id: drawer.id, values: editableValues },
    });
    const nextDrawer = unwrap<DrawerData>(response);
    setDrawer(nextDrawer);
    form.setFieldsValue(nextDrawer.record);
    message.success(t('Saved'));
    await loadContext(focus);
  };

  const addComment = async () => {
    if (!drawer) return;
    const values = await commentForm.validateFields();
    await api.request({
      url: 'ecobaseSilverData:addComment',
      method: 'post',
      data: { type: drawer.type, id: drawer.id, body: values.body },
    });
    message.success(t('Comment added'));
    commentForm.resetFields();
    await openDrawer({ type: drawer.type, id: drawer.id });
    await loadContext(focus);
  };

  const columnsFor = (section: TableSection): ColumnsType<Record<string, unknown>> => [
    {
      title: t('Select'),
      key: 'select',
      width: 80,
      render: (_value, row) => (
        <Button
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            selectFocus({ type: section.type, id: String(row.id), label: focusLabel(section.type, row) });
          }}
        >
          {t('Select')}
        </Button>
      ),
    },
    ...section.fields.map((field) => ({
      title: fieldLabel(field),
      dataIndex: field,
      key: field,
      ellipsis: true,
      render: (value: unknown) => (field === 'recordRef' ? shortRef(value) : short(value)),
    })),
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3}>{t('Semantic Model')}</Typography.Title>
        <Typography.Text type="secondary">
          {t('Use bounded lookups, then select a result to load its linked semantic context.')}
        </Typography.Text>
      </div>

      <Card>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {LOOKUPS.map((lookup) => (
              <AutoComplete
                key={lookup.type}
                allowClear
                options={optionsFor(lookup.type)}
                value={lookupText[lookup.type] ?? ''}
                onSearch={(value) => setLookupText(value ? { [lookup.type]: value } : {})}
                onChange={(value) => setLookupText(value ? { [lookup.type]: value } : {})}
                onSelect={(value) => {
                  const selected = (lookupResults[lookup.type] ?? []).find((result) => optionKey(result) === value);
                  if (selected) selectFocus({ type: selected.type, id: selected.id, label: selected.label });
                }}
                style={{ width: '100%' }}
              >
                <Input.Search addonBefore={t(lookup.label)} placeholder={t(lookup.placeholder)} />
              </AutoComplete>
            ))}
          </div>
          <Space wrap>
            <Input
              type="date"
              addonBefore={t('From')}
              value={dateFilter.from ?? ''}
              onChange={(event) => setDateFilter((current) => ({ ...current, from: event.target.value || undefined }))}
              style={{ width: 190 }}
            />
            <Input
              type="date"
              addonBefore={t('To')}
              value={dateFilter.to ?? ''}
              onChange={(event) => setDateFilter((current) => ({ ...current, to: event.target.value || undefined }))}
              style={{ width: 190 }}
            />
            <Button onClick={() => setDateFilter({})}>{t('All dates')}</Button>
            <Typography.Text strong>{t('Active focus')}:</Typography.Text>
            {focus ? <Tag color="blue">{`${fieldLabel(focus.type)} · ${focus.label}`}</Tag> : <Tag>{t('None')}</Tag>}
            <Button onClick={() => setFocus(undefined)}>{t('Clear focus')}</Button>
            {loading ? <Typography.Text type="secondary">{t('Loading silver records…')}</Typography.Text> : null}
          </Space>
        </Space>
      </Card>

      {loading && !sections.length ? (
        <Card loading>
          <Typography.Text>{t('Loading silver records…')}</Typography.Text>
        </Card>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
          gap: 16,
        }}
      >
        {sections.map((section) => (
          <Card key={section.key} title={`${section.title} (${section.rows.length})`} size="small">
            <Table
              size="small"
              loading={loading}
              rowKey={(row) => String(row.id)}
              columns={columnsFor(section)}
              dataSource={section.rows}
              pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: true }}
              scroll={{ x: true }}
              onRow={(row) => ({
                onClick: () => openDrawer({ type: section.type, id: String(row.id) }),
                style: section.highlightIds.includes(String(row.id))
                  ? { background: '#e6f4ff', cursor: 'pointer' }
                  : { cursor: 'pointer' },
              })}
            />
          </Card>
        ))}
      </div>

      <Drawer
        title={drawer?.title ?? t('Semantic record')}
        open={Boolean(drawer)}
        onClose={() => setDrawer(null)}
        width={720}
        extra={
          drawer?.editableFields.length ? (
            <Button type="primary" onClick={saveDrawer} loading={drawerLoading}>
              {t('Save')}
            </Button>
          ) : null
        }
      >
        {drawer ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Typography.Text type="secondary">{`${fieldLabel(drawer.type)} · ${shortRef(drawer.id)}`}</Typography.Text>
            <Form form={form} layout="vertical" disabled={!drawer.editableFields.length}>
              {drawerFields(drawer).map((field) => (
                <Form.Item key={field} name={field} label={fieldLabel(field)}>
                  {drawer.editableFields.includes(field) ? <Input.TextArea autoSize /> : <Input disabled />}
                </Form.Item>
              ))}
            </Form>
            <Card title={t('Comments')} size="small">
              <Space direction="vertical" style={{ width: '100%' }}>
                {(drawer.comments ?? []).map((comment) => (
                  <Card key={String(comment.id)} size="small">
                    <Typography.Text>{display(comment.body)}</Typography.Text>
                    <br />
                    <Typography.Text type="secondary">{display(comment.commentType)}</Typography.Text>
                  </Card>
                ))}
                <Form form={commentForm} layout="vertical">
                  <Form.Item name="body" rules={[{ required: true, message: t('Comment is required') }]}>
                    <Input.TextArea placeholder={t('Add a linked comment')} autoSize />
                  </Form.Item>
                  <Button onClick={addComment}>{t('Add comment')}</Button>
                </Form>
              </Space>
            </Card>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
