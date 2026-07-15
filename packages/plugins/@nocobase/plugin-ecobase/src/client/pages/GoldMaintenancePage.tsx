/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Descriptions, Input, Space, Typography } from 'antd';
import React, { useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, unknown>;

function unwrapData(response: unknown): PlainRecord {
  let data = response;
  for (let index = 0; index < 5; index += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) break;
    data = (data as PlainRecord).data;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as PlainRecord) : {};
}

function text(value: unknown) {
  return typeof value === 'string' && value ? value : '—';
}

export default function GoldMaintenancePage() {
  const t = useT();
  const api = useAPIClient();
  const [calculationDate, setCalculationDate] = useState(new Date().toISOString().slice(0, 10));
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [buildConfirmation, setBuildConfirmation] = useState('');
  const [publishConfirmation, setPublishConfirmation] = useState('');
  const [result, setResult] = useState<PlainRecord>({});
  const [verification, setVerification] = useState<PlainRecord>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = unwrapData(result.run);
  const runId = text(run.id) === '—' ? undefined : text(run.id);

  const build = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseInventoryPlanning:refreshReadModel',
        method: 'post',
        data: { calculationDate, idempotencyKey, confirmation: buildConfirmation },
      });
      setResult(unwrapData(response));
      setVerification({});
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(t('Gold rebuild failed.')));
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseInventoryPlanning:verifyRefreshRun',
        method: 'post',
        data: { runId },
      });
      setVerification(unwrapData(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(t('Gold refresh verification failed.')));
    } finally {
      setLoading(false);
    }
  };

  const publish = async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseInventoryPlanning:publishRefreshRun',
        method: 'post',
        data: { runId, confirmation: publishConfirmation },
      });
      setResult(unwrapData(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(t('Gold publication failed.')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Gold inventory maintenance')}</Typography.Title>
        <Alert
          type="warning"
          showIcon
          message={t('Administrative maintenance only')}
          description={t(
            'A rebuild writes an unpublished run. Inventory Planning keeps reading the current published run until you verify and publish the new run.',
          )}
        />
        {error ? <Alert type="error" showIcon message={error.message} /> : null}

        <Card title={t('1. Build an unpublished Gold run')}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text strong>{t('Calculation date')}</Typography.Text>
            <Input type="date" value={calculationDate} onChange={(event) => setCalculationDate(event.target.value)} />
            <Typography.Text strong>{t('Idempotency key')}</Typography.Text>
            <Space.Compact style={{ width: '100%' }}>
              <Input value={idempotencyKey} readOnly />
              <Button onClick={() => setIdempotencyKey(crypto.randomUUID())}>{t('New key')}</Button>
            </Space.Compact>
            <Typography.Text strong>{t('Type REBUILD GOLD to confirm')}</Typography.Text>
            <Input value={buildConfirmation} onChange={(event) => setBuildConfirmation(event.target.value)} />
            <Button type="primary" loading={loading} onClick={build}>
              {t('Build Gold run')}
            </Button>
          </Space>
        </Card>

        {runId ? (
          <Card title={t('2. Verify and publish')}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Descriptions bordered size="small" column={1}>
                <Descriptions.Item label={t('Run ID')}>{runId}</Descriptions.Item>
                <Descriptions.Item label={t('Status')}>{text(run.status)}</Descriptions.Item>
                <Descriptions.Item label={t('Rows')}>{String(run.rowCount ?? '—')}</Descriptions.Item>
                <Descriptions.Item label={t('Calculation date')}>{text(run.calculationDate)}</Descriptions.Item>
              </Descriptions>
              <Button loading={loading} onClick={verify}>
                {t('Verify run')}
              </Button>
              {verification.valid === true ? (
                <Alert
                  type="success"
                  showIcon
                  message={t('Run verification passed')}
                  description={`${String(verification.storedRowCount)} ${t('rows verified')}`}
                />
              ) : null}
              <Typography.Text strong>{t('Type PUBLISH GOLD to confirm')}</Typography.Text>
              <Input value={publishConfirmation} onChange={(event) => setPublishConfirmation(event.target.value)} />
              <Button
                danger
                type="primary"
                loading={loading}
                disabled={verification.valid !== true || run.status === 'published'}
                onClick={publish}
              >
                {t('Publish verified run')}
              </Button>
            </Space>
          </Card>
        ) : null}
      </Space>
    </div>
  );
}
