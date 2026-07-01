import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Col, InputNumber, Row, Space, Table, Typography } from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

type PlanningSettingKey =
  | 'safetyBufferDays'
  | 'reorderCycleDays'
  | 'orderSoonWindowDays'
  | 'leadTimeFreshnessDays'
  | 'purchasedPipelineGraceDays';

const SETTING_KEYS: PlanningSettingKey[] = [
  'safetyBufferDays',
  'reorderCycleDays',
  'orderSoonWindowDays',
  'leadTimeFreshnessDays',
  'purchasedPipelineGraceDays',
];

const SETTING_HELP: Record<PlanningSettingKey, { label: string; meaning: string; example: string; usedBy: string }> = {
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
};

function unwrapData(response: any): PlainRecord {
  let data = response;
  for (let i = 0; i < 5; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) break;
    data = data.data;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function settingValue(settings: PlainRecord, key: PlanningSettingKey) {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? value : 0;
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
    setLoading(true);
    setError(null);
    setNotice(undefined);
    try {
      const payload = Object.fromEntries(SETTING_KEYS.map((key) => [key, settingValue(settings, key)]));
      const response = await api.request({
        url: 'ecobasePlanningSettings:save',
        method: 'post',
        data: { ...payload, id: settings.id },
      });
      setSettings(unwrapData(response));
      setNotice(
        t('Planning settings saved. Refresh Inventory Planning rows to rebuild saved gold rows with these knobs.'),
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
      SETTING_KEYS.map((key) => ({
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
            'These knobs control operator-facing recommendations. Change them slowly, then refresh Inventory Planning rows and compare the queue before changing supplier decisions.',
          )}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={error.message} showIcon /> : null}
        {warning ? <Alert type="warning" message={warning} showIcon /> : null}
        {notice ? <Alert type="success" message={notice} showIcon /> : null}

        <Card>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
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
          </Space>
        </Card>

        <Card title={t('How these knobs affect formulas')}>
          <Table
            rowKey="key"
            dataSource={rows}
            pagination={false}
            columns={[
              { title: t('Knob'), dataIndex: 'name', width: 190 },
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
