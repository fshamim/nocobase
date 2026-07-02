import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Col, InputNumber, Row, Select, Space, Table, Typography } from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

type PlanningSettingKey =
  | 'safetyBufferDays'
  | 'reorderCycleDays'
  | 'orderSoonWindowDays'
  | 'leadTimeFreshnessDays'
  | 'purchasedPipelineGraceDays';

type ProfitTierSettingKey = 'profitTierAThreshold' | 'profitTierBThreshold' | 'profitTierCThreshold';
type NumberSettingKey = PlanningSettingKey | ProfitTierSettingKey;

type StatusBucketKey =
  | 'supplierOrderPlacedNotPurchasedStatuses'
  | 'supplierOrderPurchasedPipelineStatuses'
  | 'supplierOrderClosedStatuses';

const SETTING_KEYS: PlanningSettingKey[] = [
  'safetyBufferDays',
  'reorderCycleDays',
  'orderSoonWindowDays',
  'leadTimeFreshnessDays',
  'purchasedPipelineGraceDays',
];

const PROFIT_TIER_KEYS: ProfitTierSettingKey[] = [
  'profitTierAThreshold',
  'profitTierBThreshold',
  'profitTierCThreshold',
];

const NUMBER_SETTING_KEYS: NumberSettingKey[] = [...SETTING_KEYS, ...PROFIT_TIER_KEYS];

const STATUS_BUCKET_KEYS: StatusBucketKey[] = [
  'supplierOrderPlacedNotPurchasedStatuses',
  'supplierOrderPurchasedPipelineStatuses',
  'supplierOrderClosedStatuses',
];

const SETTING_HELP: Record<NumberSettingKey, { label: string; meaning: string; example: string; usedBy: string }> = {
  safetyBufferDays: {
    label: 'Safety buffer days',
    meaning: 'Extra cushion added before stockout so operators are not ordering at the last possible day.',
    example:
      'If velocity is 5/day, increasing this from 7 to 10 adds 15 units to suggested quantity: 5 × 3 extra days.',
    usedBy: 'Suggested quantity, latest safe reorder date, money at risk, Inventory Planning action status.',
  },
  reorderCycleDays: {
    label: 'Reorder cycle days',
    meaning: 'Extra selling days to cover after the supplier lead time, so the team is not placing tiny repeat orders.',
    example:
      'If velocity is 5/day, increasing this from 30 to 45 adds 75 units to suggested quantity: 5 × 15 extra days.',
    usedBy: 'Suggested quantity and budget optimizer candidate sizing.',
  },
  orderSoonWindowDays: {
    label: 'Order-soon window days',
    meaning: 'How many days before the safe reorder date EcoBase starts flagging a product as order_soon.',
    example: 'If the safe reorder date is 10 days away and this is 14, the row becomes order_soon instead of watch.',
    usedBy: 'Inventory Planning action status, digest queue sections, operator filters.',
  },
  leadTimeFreshnessDays: {
    label: 'Lead-time freshness days',
    meaning: 'How old a confirmed supplier lead time can be before EcoBase marks it stale and asks for reconfirmation.',
    example: 'If this is 60 and lead time was confirmed 75 days ago, the row becomes stale_lead_time.',
    usedBy: 'Lead-time freshness tag, Inventory Planning action status, digest queue.',
  },
  purchasedPipelineGraceDays: {
    label: 'Purchased pipeline grace days',
    meaning:
      'How long after an expected sellable date a paid/preparing/shipped order still counts as reliable open-order coverage.',
    example:
      'If this is 3, an order expected 2 days ago still reduces suggested quantity; one expected 5 days ago does not.',
    usedBy: 'Reliable open-order coverage and suggested quantity.',
  },
  profitTierAThreshold: {
    label: 'Profit tier A threshold',
    meaning: 'Minimum profit score for Tier A. Profit score is Profit per unit × recommended best quantity.',
    example: 'If profit/unit is 20 and recommended quantity is 20, score is 400. With A = 250, it is Tier A.',
    usedBy: 'Tier, money-at-risk visibility, digest priority, budget optimizer ordering.',
  },
  profitTierBThreshold: {
    label: 'Profit tier B threshold',
    meaning: 'Minimum profit score for Tier B. Scores below A but at or above B become Tier B.',
    example: 'If score is 150 and B = 100, it is Tier B unless A threshold is also met.',
    usedBy: 'Tier, money-at-risk visibility, digest priority, budget optimizer ordering.',
  },
  profitTierCThreshold: {
    label: 'Profit tier C threshold',
    meaning: 'Minimum score above which a product becomes Tier C. Scores at or below this are unclassified.',
    example: 'Default C = 0 means any positive score below B is Tier C.',
    usedBy: 'Tier and risk classification.',
  },
};

const STATUS_BUCKET_HELP: Record<StatusBucketKey, { label: string; meaning: string }> = {
  supplierOrderPlacedNotPurchasedStatuses: {
    label: 'Placed but not purchased',
    meaning:
      'Open order statuses that should hold the row in placed_not_purchased instead of counting as stock coverage.',
  },
  supplierOrderPurchasedPipelineStatuses: {
    label: 'Purchased pipeline coverage',
    meaning:
      'Open order statuses that reduce suggested reorder quantity while still inside the purchased-pipeline grace window.',
  },
  supplierOrderClosedStatuses: {
    label: 'Closed / ignored',
    meaning: 'Statuses that should be treated as closed history even if payment or approval fields look complete.',
  },
};

const STATUS_OPTIONS = [
  'draft',
  'supplier_contacted',
  'supplier_confirmed',
  'approval_pending',
  'payment_pending',
  'paid',
  'supplier_preparing',
  'shipped_inbound',
  'reached_fba',
  'completed',
  'blocked',
  'rejected',
  'cancelled',
].map((value) => ({ label: value, value }));

function unwrapData(response: any): PlainRecord {
  let data = response;
  for (let i = 0; i < 5; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) break;
    data = data.data;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function settingValue(settings: PlainRecord, key: NumberSettingKey) {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? value : 0;
}

function statusList(settings: PlainRecord, key: StatusBucketKey) {
  return Array.isArray(settings[key]) ? settings[key].map(String) : [];
}

function normalizeStatus(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function duplicateStatus(settings: PlainRecord) {
  const owner = new Map<string, string>();
  for (const key of STATUS_BUCKET_KEYS) {
    for (const raw of statusList(settings, key)) {
      const status = normalizeStatus(raw);
      if (!status) continue;
      const existing = owner.get(status);
      if (existing) return `${status} is in both ${existing} and ${STATUS_BUCKET_HELP[key].label}.`;
      owner.set(status, STATUS_BUCKET_HELP[key].label);
    }
  }
  return undefined;
}

export default function PlanningSettingsPage() {
  const t = useT();
  const api = useAPIClient();
  const [settings, setSettings] = useState<PlainRecord>({});
  const [defaults, setDefaults] = useState<PlainRecord>({});
  const [warning, setWarning] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(undefined);
    try {
      const response = await api.request({ url: 'ecobasePlanningSettings:get', method: 'post', data: {} });
      const data = unwrapData(response);
      setSettings(data.settings ?? {});
      setDefaults(data.defaults ?? {});
      setWarning(typeof data.warning === 'string' ? data.warning : undefined);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api]);

  const saveSettings = useCallback(async () => {
    const duplicate = duplicateStatus(settings);
    if (duplicate) {
      setError(new Error(duplicate));
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(undefined);
    try {
      const payload = {
        ...Object.fromEntries(NUMBER_SETTING_KEYS.map((key) => [key, settingValue(settings, key)])),
        ...Object.fromEntries(STATUS_BUCKET_KEYS.map((key) => [key, statusList(settings, key)])),
      };
      const response = await api.request({
        url: 'ecobasePlanningSettings:save',
        method: 'post',
        data: { ...payload, id: settings.id },
      });
      setSettings(unwrapData(response));
      setNotice(
        t('Planning settings saved. Refresh Inventory Planning rows to rebuild saved gold rows with these rules.'),
      );
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, settings, t]);

  const resetSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(undefined);
    try {
      const response = await api.request({ url: 'ecobasePlanningSettings:reset', method: 'post', data: {} });
      setSettings(unwrapData(response));
      setNotice(t('Planning settings reset to defaults.'));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const rows = useMemo(
    () =>
      NUMBER_SETTING_KEYS.map((key) => ({
        key,
        name: SETTING_HELP[key].label,
        current: settingValue(settings, key),
        defaultValue: defaults[key],
        meaning: SETTING_HELP[key].meaning,
        example: SETTING_HELP[key].example,
        usedBy: SETTING_HELP[key].usedBy,
      })),
    [defaults, settings],
  );

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('EcoBase planning settings')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t(
            'These rules control operator-facing recommendations. Change them slowly, then refresh Inventory Planning rows and compare the queue before changing supplier decisions.',
          )}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={error.message} showIcon /> : null}
        {warning ? <Alert type="warning" message={warning} showIcon /> : null}
        {notice ? <Alert type="success" message={notice} showIcon /> : null}

        <Card title={t('Planning day knobs')}>
          <Row gutter={[12, 12]}>
            {SETTING_KEYS.map((key) => (
              <Col xs={24} md={8} key={key}>
                <Typography.Text strong>{t(SETTING_HELP[key].label)}</Typography.Text>
                <InputNumber
                  min={0}
                  precision={0}
                  addonAfter={t('days')}
                  value={settingValue(settings, key)}
                  onChange={(value) => setSettings({ ...settings, [key]: Number(value ?? 0) })}
                  style={{ width: '100%', marginTop: 6 }}
                />
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  {t(SETTING_HELP[key].meaning)}
                </Typography.Paragraph>
              </Col>
            ))}
          </Row>
        </Card>

        <Card title={t('Profit tier thresholds')}>
          <Row gutter={[12, 12]}>
            {PROFIT_TIER_KEYS.map((key) => (
              <Col xs={24} md={8} key={key}>
                <Typography.Text strong>{t(SETTING_HELP[key].label)}</Typography.Text>
                <InputNumber
                  min={0}
                  precision={0}
                  addonAfter={t('score')}
                  value={settingValue(settings, key)}
                  onChange={(value) => setSettings({ ...settings, [key]: Number(value ?? 0) })}
                  style={{ width: '100%', marginTop: 6 }}
                />
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  {t(SETTING_HELP[key].meaning)}
                </Typography.Paragraph>
              </Col>
            ))}
          </Row>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            {t('Validation requires A threshold > B threshold > C threshold.')}
          </Typography.Paragraph>
        </Card>

        <Card title={t('Supplier order status buckets')}>
          <Row gutter={[12, 12]}>
            {STATUS_BUCKET_KEYS.map((key) => (
              <Col xs={24} md={8} key={key}>
                <Typography.Text strong>{t(STATUS_BUCKET_HELP[key].label)}</Typography.Text>
                <Select
                  mode="tags"
                  tokenSeparators={[',', '\n']}
                  options={STATUS_OPTIONS}
                  value={statusList(settings, key)}
                  onChange={(value) => setSettings({ ...settings, [key]: value })}
                  style={{ width: '100%', marginTop: 6 }}
                  placeholder={t('Add status')}
                />
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  {t(STATUS_BUCKET_HELP[key].meaning)}
                </Typography.Paragraph>
              </Col>
            ))}
          </Row>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            {t('A status can only be in one bucket. Type a new status and press Enter to add it.')}
          </Typography.Paragraph>
        </Card>

        <Space>
          <Button type="primary" loading={loading} onClick={saveSettings}>
            {t('Save planning settings')}
          </Button>
          <Button loading={loading} onClick={resetSettings}>
            {t('Reset defaults')}
          </Button>
          <Button loading={loading} onClick={loadSettings}>
            {t('Reload')}
          </Button>
        </Space>

        <Card title={t('How these settings affect formulas')}>
          <Table
            rowKey="key"
            dataSource={rows}
            pagination={false}
            columns={[
              { title: t('Setting'), dataIndex: 'name', width: 190 },
              { title: t('Current'), dataIndex: 'current', width: 90 },
              { title: t('Default'), dataIndex: 'defaultValue', width: 90 },
              { title: t('Meaning'), dataIndex: 'meaning' },
              { title: t('Example'), dataIndex: 'example' },
              { title: t('Used by'), dataIndex: 'usedBy' },
            ]}
          />
        </Card>
      </Space>
    </div>
  );
}
