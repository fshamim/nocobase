/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Descriptions, Space, Typography } from 'antd';
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
  const [result, setResult] = useState<PlainRecord>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = unwrapData(result.run);

  const refreshAndPublish = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseInventoryPlanning:refreshAndPublish',
        method: 'post',
        data: {},
      });
      setResult(unwrapData(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(t('Gold refresh and publication failed.')));
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
          message={t('Operator publication control')}
          description={t(
            'This action rebuilds the complete Gold candidate from one Silver snapshot, validates it at the Gold boundary, and publishes it atomically. Existing published data remains active if any stage fails.',
          )}
        />
        {error ? <Alert type="error" showIcon message={error.message} /> : null}

        <Card title={t('Refresh and publish Gold')}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button type="primary" loading={loading} onClick={refreshAndPublish}>
              {t('Refresh and publish')}
            </Button>
          </Space>
        </Card>

        {result.status === 'published' || result.status === 'reused' ? (
          <Alert
            type="success"
            showIcon
            message={result.status === 'reused' ? t('Published Gold run reused') : t('Gold publication completed')}
            description={t('Inventory Planning now reads this published run.')}
          />
        ) : null}
        {result.status === 'failed' ? (
          <Alert
            type="error"
            showIcon
            message={t('Gold refresh and publication failed.')}
            description={text(result.code)}
          />
        ) : null}

        {run.id ? (
          <Card title={t('Published run')}>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label={t('Run ID')}>{text(run.id)}</Descriptions.Item>
              <Descriptions.Item label={t('Status')}>{text(run.status)}</Descriptions.Item>
              <Descriptions.Item label={t('Listings')}>{String(run.listingRowCount ?? '—')}</Descriptions.Item>
              <Descriptions.Item label={t('Family actions')}>
                {String(run.familyActionProjectionCount ?? '—')}
              </Descriptions.Item>
              <Descriptions.Item label={t('Calculation date')}>{text(run.calculationDate)}</Descriptions.Item>
              <Descriptions.Item label={t('Publication digest')}>
                {text(run.publicationPayloadDigest)}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        ) : null}
      </Space>
    </div>
  );
}
