import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
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

export default function AiEvidencePage() {
  const t = useT();
  const api = useAPIClient();
  const [question, setQuestion] = useState('What needs immediate management focus today?');
  const [answer, setAnswer] = useState<PlainRecord | null>(null);
  const [coverage, setCoverage] = useState<PlainRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    api.request({ url: 'ecobaseAi:coverage', method: 'post', data: {} })
      .then((response) => setCoverage(unwrapData(response) ?? []))
      .catch((err) => setError(err as Error));
  }, [api]);

  const ask = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.request({ url: 'ecobaseAi:answer', method: 'post', data: { question } });
      setAnswer(unwrapData(response));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [api, question]);

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={3}>{t('Ecobase AI evidence')}</Typography.Title>
        {error ? <Alert type="error" message={error.message} /> : null}
        <Alert type="info" message={t('This AI retrieval surface answers from internal Ecobase records and cannot create, suppress, or resolve deterministic alerts.')} />
        <Card>
          <Space.Compact style={{ width: '100%' }}>
            <Input value={question} onChange={(event) => setQuestion(event.target.value)} />
            <Button type="primary" onClick={ask} loading={loading}>{t('Ask with evidence')}</Button>
          </Space.Compact>
        </Card>
        {answer ? (
          <Card title={t('Evidence-backed answer')}>
            <Typography.Paragraph>{answer.response}</Typography.Paragraph>
            <Space wrap>
              <Tag>{answer.provider}</Tag>
              <Tag>{answer.model}</Tag>
              <Tag color={answer.dataCompleteness === 'complete' ? 'green' : 'orange'}>{answer.dataCompleteness}</Tag>
              <Tag>{answer.confidence}</Tag>
            </Space>
            <Table<PlainRecord>
              style={{ marginTop: 16 }}
              rowKey={(row, index) => `${row.type}:${row.id ?? index}`}
              dataSource={answer.evidenceReferences ?? []}
              pagination={{ pageSize: 10 }}
              columns={[
                { title: t('Type'), dataIndex: 'type', key: 'type' },
                { title: t('ID'), dataIndex: 'id', key: 'id' },
                { title: t('Label'), dataIndex: 'label', key: 'label' },
              ]}
            />
          </Card>
        ) : null}
        <Card title={t('Appendix A coverage matrix')}>
          <Table<PlainRecord>
            rowKey="group"
            dataSource={coverage}
            pagination={false}
            columns={[
              { title: t('Group'), dataIndex: 'group', key: 'group' },
              { title: t('Status'), dataIndex: 'status', key: 'status', render: (value) => <Tag color={value === 'answerable' ? 'green' : 'orange'}>{value}</Tag> },
              { title: t('Retrieval tool'), dataIndex: 'retrievalTool', key: 'retrievalTool' },
              { title: t('Questions'), dataIndex: 'questions', key: 'questions' },
            ]}
          />
        </Card>
      </Space>
    </div>
  );
}
