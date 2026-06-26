import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Col, Input, Row, Select, Space, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;
type CompanyOption = { label: string; value: string };

const { TextArea } = Input;

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

function rows(value: any): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function lines(value: string) {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function DailyBriefPromptSettingsPage() {
  const t = useT();
  const api = useAPIClient();
  const [company, setCompany] = useState<string | undefined>();
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [settings, setSettings] = useState<PlainRecord>({});
  const [warning, setWarning] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadCompanies = useCallback(async () => {
    const response = await api.request({ url: 'ecobaseCompanies:list?paginate=false', method: 'get' });
    setCompanies(
      unwrapRows(response)
        .map((row) => ({ label: typeof row.name === 'string' ? row.name : '', value: String(row.name ?? '') }))
        .filter((row) => row.value),
    );
  }, [api]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(undefined);
    try {
      const response = await api.request({
        url: 'ecobaseReports:getDailyBriefPromptSettings',
        method: 'post',
        data: { company },
      });
      const data = unwrapData(response);
      setSettings(data.settings ?? data);
      setWarning(typeof data.warning === 'string' ? data.warning : undefined);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, company]);

  const saveSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(undefined);
    try {
      const response = await api.request({
        url: 'ecobaseReports:saveDailyBriefPromptSettings',
        method: 'post',
        data: { ...settings, id: company && !settings.company ? undefined : settings.id, company },
      });
      setSettings(unwrapData(response));
      setNotice(t('Daily brief AI settings saved.'));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, company, settings, t]);

  const resetSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(undefined);
    try {
      const response = await api.request({
        url: 'ecobaseReports:resetDailyBriefPromptSettings',
        method: 'post',
        data: { company },
      });
      setSettings(unwrapData(response));
      setNotice(t('Daily brief AI settings reset.'));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, company, t]);

  useEffect(() => {
    void loadCompanies();
  }, [loadCompanies]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Daily brief AI settings')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('These preferences change Eco’s wording only. Evidence and validation rules remain locked.')}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={error.message} /> : null}
        {warning ? <Alert type="warning" message={warning} showIcon /> : null}
        {notice ? <Alert type="success" message={notice} showIcon /> : null}

        <Card>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Select
              allowClear
              showSearch
              placeholder={t('Global / all companies')}
              value={company}
              onChange={setCompany}
              options={companies}
              optionFilterProp="label"
              style={{ width: 320 }}
            />
            <Alert
              type="info"
              showIcon
              message={t('Evidence and validation rules are locked and cannot be overridden.')}
            />
            <Row gutter={[12, 12]}>
              <Col xs={24} md={8}>
                <Input
                  placeholder={t('Setting name')}
                  value={settings.name ?? ''}
                  onChange={(event) => setSettings({ ...settings, name: event.target.value })}
                />
              </Col>
              <Col xs={24} md={8}>
                <Input
                  placeholder={t('Audience')}
                  value={settings.audience ?? ''}
                  onChange={(event) => setSettings({ ...settings, audience: event.target.value })}
                />
              </Col>
              <Col xs={24} md={8}>
                <Input
                  placeholder={t('Tone')}
                  value={settings.tone ?? ''}
                  onChange={(event) => setSettings({ ...settings, tone: event.target.value })}
                />
              </Col>
            </Row>
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <Input
                  placeholder={t('Model override')}
                  value={settings.model ?? ''}
                  onChange={(event) => setSettings({ ...settings, model: event.target.value })}
                />
              </Col>
              <Col xs={24} md={12}>
                <Input
                  placeholder={t('LLM service override')}
                  value={settings.llmService ?? ''}
                  onChange={(event) => setSettings({ ...settings, llmService: event.target.value })}
                />
              </Col>
            </Row>
            <TextArea
              rows={4}
              placeholder={t('Director instructions for Eco. Example: lead with cash risk, then status checks.')}
              value={settings.directorInstructions ?? ''}
              onChange={(event) => setSettings({ ...settings, directorInstructions: event.target.value })}
            />
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <TextArea
                  rows={3}
                  placeholder={t('Must include, one per line')}
                  value={rows(settings.mustInclude).join('\n')}
                  onChange={(event) => setSettings({ ...settings, mustInclude: lines(event.target.value) })}
                />
              </Col>
              <Col xs={24} md={12}>
                <TextArea
                  rows={3}
                  placeholder={t('Must avoid, one per line')}
                  value={rows(settings.mustAvoid).join('\n')}
                  onChange={(event) => setSettings({ ...settings, mustAvoid: lines(event.target.value) })}
                />
              </Col>
            </Row>
            <Space>
              <Button type="primary" onClick={saveSettings} loading={loading}>
                {t('Save AI settings')}
              </Button>
              <Button onClick={resetSettings} loading={loading}>
                {t('Reset defaults')}
              </Button>
            </Space>
          </Space>
        </Card>
      </Space>
    </div>
  );
}
