import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Space, Table, Tag, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, any>;

function unwrapData(response: any): any {
  let data = response;
  for (let i = 0; i < 4; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) break;
    data = data.data;
  }
  return data;
}

export default function AccuracyHarnessPage() {
  const t = useT();
  const api = useAPIClient();
  const [checklist, setChecklist] = useState<PlainRecord>({});
  const [signoff, setSignoff] = useState<PlainRecord | null>(null);
  const [evaluation, setEvaluation] = useState<PlainRecord | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    api.request({ url: 'ecobaseAccuracy:checklistTemplate', method: 'post', data: {} })
      .then((response) => setChecklist(unwrapData(response) ?? {}))
      .catch((err) => setError(err as Error));
  }, [api]);

  const createDraft = useCallback(async () => {
    try {
      setError(null);
      const response = await api.request({ url: 'ecobaseAccuracy:recordSignoff', method: 'post', data: { status: 'draft', checklist, notes: 'Draft created from local harness page.' } });
      setSignoff(unwrapData(response));
    } catch (err) {
      setError(err as Error);
    }
  }, [api, checklist]);

  const evaluate = useCallback(async () => {
    if (!signoff?.id) return;
    try {
      setError(null);
      const response = await api.request({ url: 'ecobaseAccuracy:evaluate', method: 'post', data: { dataQualitySignoffId: signoff.id } });
      setEvaluation(unwrapData(response));
    } catch (err) {
      setError(err as Error);
    }
  }, [api, signoff]);

  const rows = Object.entries(checklist).map(([key, value]) => ({ key, ...(value as PlainRecord) }));

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Ecobase data-quality sign-off and accuracy harness')}</Typography.Title>
        {error ? <Alert type="error" message={error.message} /> : null}
        <Alert type="warning" message={t('Formal accuracy scoring is blocked until the user/business records data-quality-signed-off inputs. Credential blockers do not count as sign-off.')} />
        <Card title={t('Checklist template')} extra={<Button onClick={createDraft}>{t('Create draft sign-off')}</Button>}>
          <Table<PlainRecord>
            rowKey="key"
            dataSource={rows}
            pagination={false}
            columns={[
              { title: t('Item'), dataIndex: 'key', key: 'key' },
              { title: t('Status'), dataIndex: 'status', key: 'status', render: (value) => <Tag color={value === 'approved' ? 'green' : 'orange'}>{value}</Tag> },
              { title: t('Evidence'), dataIndex: 'evidence', key: 'evidence', render: (value) => value ? JSON.stringify(value) : 'Not recorded' },
            ]}
          />
        </Card>
        {signoff ? <Alert type="info" message={`${t('Sign-off status')}: ${signoff.status}`} description={signoff.id} /> : null}
        {signoff ? <Button onClick={evaluate}>{t('Run evaluation harness')}</Button> : null}
        {evaluation ? (
          <Card title={t('Evaluation report')}>
            <Typography.Paragraph>{`${t('Status')}: ${evaluation.status}`}</Typography.Paragraph>
            <pre>{JSON.stringify(evaluation.report, null, 2)}</pre>
          </Card>
        ) : null}
      </Space>
    </div>
  );
}
