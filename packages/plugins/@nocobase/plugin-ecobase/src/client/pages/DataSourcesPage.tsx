import { useAPIClient } from '@nocobase/client';
import { Alert, App, Button, Card, Descriptions, Input, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import type { UploadFile, UploadProps } from 'antd';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../locale';

type PlainRecord = Record<string, unknown>;

type UploadedCsvFile = {
  uid: string;
  name: string;
  content: string;
};

type CsvFileAnalysis = {
  name: string;
  checksum: string;
  rowCount: number;
  detectedShape: string;
  adapterName: string | null;
  sourceType: string | null;
  domain: string | null;
  importable: boolean;
  warnings: string[];
};

type CsvBundleAnalysisGroup = {
  adapterName: string;
  sourceType: string;
  domain: string;
  files: string[];
};

type CsvBundleAnalysis = {
  files: CsvFileAnalysis[];
  groups: CsvBundleAnalysisGroup[];
};

type SourceStatusRow = {
  sourceConnectionId: string;
  connectionName: string;
  companyId: string | null;
  companyName: string | null;
  sourceType: string;
  domain: string;
  active: boolean;
  latestImportRunId: string | null;
  latestRunStatus: string | null;
  lastRunAt: string | null;
  rowCount: number;
  normalizedCount: number;
  warningCount: number;
  errorCount: number;
};

type CompanyOption = { label: string; value: string };

type ImportRunResult = {
  id?: string;
  status?: string;
  rowCount?: number;
  normalizedCount?: number;
  warningCount?: number;
  errorCount?: number;
  errorMessage?: string | null;
};

function unwrapRows(response: unknown): PlainRecord[] {
  let data = response;
  for (let i = 0; i < 6; i += 1) {
    if (Array.isArray(data)) return data.filter((row): row is PlainRecord => typeof row === 'object' && row !== null);
    if (!data || typeof data !== 'object' || !('data' in data)) break;
    data = (data as PlainRecord).data;
  }
  return Array.isArray(data) ? data.filter((row): row is PlainRecord => typeof row === 'object' && row !== null) : [];
}

function unwrapRecord(response: unknown): PlainRecord {
  let data = response;
  for (let i = 0; i < 6; i += 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) break;
    data = (data as PlainRecord).data;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as PlainRecord) : {};
}

function normalizeAnalysis(response: unknown): CsvBundleAnalysis {
  const record = unwrapRecord(response);
  return {
    files: Array.isArray(record.files) ? (record.files as CsvFileAnalysis[]) : [],
    groups: Array.isArray(record.groups) ? (record.groups as CsvBundleAnalysisGroup[]) : [],
  };
}

function statusColor(status: string | null | undefined) {
  if (!status) return 'default';
  if (status === 'success') return 'green';
  if (status === 'skipped') return 'blue';
  if (status === 'partial') return 'orange';
  if (status === 'failed' || status === 'blocked') return 'red';
  return 'default';
}

function shortChecksum(value: string) {
  return value ? value.slice(0, 12) : '—';
}

function groupKey(group: CsvBundleAnalysisGroup) {
  return `${group.adapterName}:${group.sourceType}:${group.domain}`;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export default function DataSourcesPage() {
  const t = useT();
  const api = useAPIClient();
  const { message } = App.useApp();
  const [sourceRows, setSourceRows] = useState<SourceStatusRow[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [company, setCompany] = useState<string | undefined>();
  const [sourceVersion, setSourceVersion] = useState(todayIsoDate());
  const [files, setFiles] = useState<UploadedCsvFile[]>([]);
  const [analysis, setAnalysis] = useState<CsvBundleAnalysis | null>(null);
  const [selectedConnections, setSelectedConnections] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, ImportRunResult>>({});
  const [runningGroups, setRunningGroups] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<'initial' | 'analyze' | 'run' | null>('initial');
  const [error, setError] = useState<Error | null>(null);

  const uploadFileList: UploadFile[] = useMemo(
    () => files.map((file) => ({ uid: file.uid, name: file.name, status: 'done', size: file.content.length })),
    [files],
  );

  const loadInitialData = useCallback(async () => {
    setLoading('initial');
    setError(null);
    try {
      const [statusResponse, companyResponse] = await Promise.all([
        api.request({ url: 'ecobaseImport:status', method: 'get' }),
        api.request({ url: 'ecobaseCompanies:list?paginate=false', method: 'get' }),
      ]);
      const nextSourceRows = unwrapRows(statusResponse) as SourceStatusRow[];
      setSourceRows(nextSourceRows);
      setCompanies(
        unwrapRows(companyResponse)
          .map((row) => {
            const name = typeof row.name === 'string' ? row.name : '';
            return { label: name, value: name };
          })
          .filter((row) => row.value.length > 0),
      );
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(null);
    }
  }, [api]);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  const beforeUpload: UploadProps['beforeUpload'] = async (file) => {
    const content = await file.text();
    setFiles((current) => [
      ...current.filter((currentFile) => currentFile.name !== file.name),
      { uid: file.uid, name: file.name, content },
    ]);
    setAnalysis(null);
    setResults({});
    return false;
  };

  const removeFile: UploadProps['onRemove'] = (file) => {
    setFiles((current) => current.filter((currentFile) => currentFile.uid !== file.uid));
    setAnalysis(null);
    setResults({});
    return true;
  };

  const analyze = async () => {
    setLoading('analyze');
    setError(null);
    setResults({});
    try {
      const response = await api.request({
        url: 'ecobaseImport:analyzeCsvBundle',
        method: 'post',
        data: { defaultCompany: company, files: files.map(({ name, content }) => ({ name, content })) },
      });
      const nextAnalysis = normalizeAnalysis(response);
      setAnalysis(nextAnalysis);
      const nextSelections: Record<string, string> = {};
      for (const group of nextAnalysis.groups) {
        const [match] = sourceOptionsForGroup(group);
        if (match) {
          nextSelections[groupKey(group)] = match.value;
        }
      }
      setSelectedConnections(nextSelections);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(null);
    }
  };

  const runGroup = async (group: CsvBundleAnalysisGroup) => {
    const key = groupKey(group);
    const sourceConnectionId = selectedConnections[key];
    if (!sourceConnectionId) {
      message.error(t('Choose a source connection before running this group'));
      return;
    }
    setLoading('run');
    setError(null);
    try {
      const groupFiles = files
        .filter((file) => group.files.includes(file.name))
        .map(({ name, content }) => ({ name, content }));
      const response = await api.request({
        url: 'ecobaseImport:runCsvBundle',
        method: 'post',
        data: {
          sourceConnectionId,
          adapterName: group.adapterName,
          sourceIdentifier: `manual-${group.adapterName}`,
          sourceVersion,
          defaultCompany: company,
          files: groupFiles,
        },
      });
      const result = unwrapRecord(response) as ImportRunResult;
      setResults((current) => ({ ...current, [key]: result }));
      if (result.status === 'pending' && result.id) {
        setRunningGroups((current) => ({ ...current, [key]: result.id as string }));
        message.info(t('CSV import is running in the background. This page will refresh until it completes.'));
      } else {
        message.success(t('CSV import finished'));
      }
      await loadInitialData();
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(null);
    }
  };

  const runAllGroups = async () => {
    if (!analysis) return;
    for (const group of analysis.groups) {
      await runGroup(group);
    }
  };

  const createSourceForGroup = async (group: CsvBundleAnalysisGroup) => {
    const key = groupKey(group);
    setLoading('run');
    setError(null);
    try {
      const response = await api.request({
        url: 'ecobaseImport:saveCsvSourceConnection',
        method: 'post',
        data: {
          name: `${group.sourceType} ${group.domain} CSV upload`,
          sourceType: group.sourceType,
          domain: group.domain,
          companyName: company,
        },
      });
      const created = unwrapRecord(response);
      const sourceConnectionId = typeof created.id === 'string' ? created.id : undefined;
      await loadInitialData();
      if (sourceConnectionId) {
        setSelectedConnections((current) => ({ ...current, [key]: sourceConnectionId }));
      }
      message.success(t('Source connection created'));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(null);
    }
  };

  useEffect(() => {
    const entries = Object.entries(runningGroups);
    if (entries.length === 0) return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const statusResponse = await api.request({ url: 'ecobaseImport:status', method: 'get' });
          const nextSourceRows = unwrapRows(statusResponse) as SourceStatusRow[];
          setSourceRows(nextSourceRows);
          setRunningGroups((current) => {
            const next = { ...current };
            for (const [key, importRunId] of Object.entries(current)) {
              const status = nextSourceRows.find((row) => row.latestImportRunId === importRunId);
              if (status && status.latestRunStatus !== 'pending') {
                setResults((resultsByKey) => ({
                  ...resultsByKey,
                  [key]: {
                    id: importRunId,
                    status: status.latestRunStatus ?? undefined,
                    rowCount: status.rowCount,
                    normalizedCount: status.normalizedCount,
                    warningCount: status.latestRunWarningCount ?? status.warningCount,
                    errorCount: status.errorCount,
                  },
                }));
                delete next[key];
              }
            }
            return next;
          });
        } catch (err) {
          setError(err as Error);
        }
      })();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [api, runningGroups]);

  const sourceOptionsForGroup = (group: CsvBundleAnalysisGroup) =>
    sourceRows
      .filter((row) => row.sourceType === group.sourceType && row.domain === group.domain && row.active)
      .filter((row) => !company || !row.companyName || row.companyName === company)
      .sort((left, right) => {
        const leftScoped = left.companyName === company ? 0 : 1;
        const rightScoped = right.companyName === company ? 0 : 1;
        if (leftScoped !== rightScoped) return leftScoped - rightScoped;
        return left.connectionName.localeCompare(right.connectionName);
      })
      .map((row) => ({
        label: `${row.connectionName} · ${row.companyName ?? t('All companies')} (${row.sourceConnectionId})`,
        value: row.sourceConnectionId,
      }));

  const importableCount = analysis?.files.filter((file) => file.importable).length ?? 0;
  const blockedCount = analysis ? analysis.files.length - importableCount : 0;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3}>{t('Ecobase data sources')}</Typography.Title>
      <Typography.Paragraph type="secondary">
        {t(
          'Upload fresh CSV exports, preview their detected shapes, and import them through the existing Ecobase adapter pipeline without storing file content in source connection config.',
        )}
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error.message} /> : null}

      <Card
        title={t('Source connections')}
        loading={loading === 'initial'}
        extra={<Button onClick={loadInitialData}>{t('Refresh')}</Button>}
      >
        <Table
          rowKey="sourceConnectionId"
          dataSource={sourceRows}
          pagination={{ pageSize: 6 }}
          columns={[
            { title: t('Connection'), dataIndex: 'connectionName', key: 'connectionName' },
            { title: t('Source type'), dataIndex: 'sourceType', key: 'sourceType' },
            { title: t('Domain'), dataIndex: 'domain', key: 'domain' },
            {
              title: t('Latest status'),
              dataIndex: 'latestRunStatus',
              key: 'latestRunStatus',
              render: (value: string | null) => <Tag color={statusColor(value)}>{value ?? t('No runs')}</Tag>,
            },
            { title: t('Rows'), dataIndex: 'rowCount', key: 'rowCount' },
            { title: t('Normalized'), dataIndex: 'normalizedCount', key: 'normalizedCount' },
            { title: t('Warnings'), dataIndex: 'warningCount', key: 'warningCount' },
            {
              title: t('Last run time'),
              dataIndex: 'lastRunAt',
              key: 'lastRunAt',
              render: (value: string | null) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm') : t('Never')),
            },
          ]}
        />
      </Card>

      <Card title={t('Upload CSV bundle')}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Select
              allowClear
              showSearch
              style={{ minWidth: 260 }}
              placeholder={t('Default company')}
              value={company}
              options={companies}
              onChange={setCompany}
              optionFilterProp="label"
            />
            <Input
              style={{ width: 180 }}
              value={sourceVersion}
              aria-label={t('Source version')}
              onChange={(event) => setSourceVersion(event.target.value)}
            />
            <Button type="primary" disabled={files.length === 0} loading={loading === 'analyze'} onClick={analyze}>
              {t('Analyze CSV bundle')}
            </Button>
          </Space>
          <Upload.Dragger
            multiple
            accept=".csv,text/csv"
            beforeUpload={beforeUpload}
            onRemove={removeFile}
            fileList={uploadFileList}
          >
            <p>{t('Drop CSV files here or click to select files')}</p>
            <p>
              {t(
                'OrderDetails, Purchase Orders, Pre-Order Sheet, Supplier IDs, Buybox, MasterStock, and Sellerboard/Amazon operation CSVs are supported.',
              )}
            </p>
          </Upload.Dragger>
        </Space>
      </Card>

      {analysis ? (
        <Card
          title={t('CSV preview')}
          extra={
            <Space>
              <Tag color="green">
                {t('Importable')}: {importableCount}
              </Tag>
              <Tag color={blockedCount > 0 ? 'red' : 'default'}>
                {t('Blocked')}: {blockedCount}
              </Tag>
            </Space>
          }
        >
          <Table
            rowKey="name"
            dataSource={analysis.files}
            pagination={false}
            columns={[
              { title: t('File'), dataIndex: 'name', key: 'name' },
              { title: t('Shape'), dataIndex: 'detectedShape', key: 'detectedShape' },
              { title: t('Rows'), dataIndex: 'rowCount', key: 'rowCount' },
              {
                title: t('Adapter'),
                dataIndex: 'adapterName',
                key: 'adapterName',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: t('Source type'),
                dataIndex: 'sourceType',
                key: 'sourceType',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: t('Domain'),
                dataIndex: 'domain',
                key: 'domain',
                render: (value: string | null) => value ?? '—',
              },
              { title: t('Checksum'), dataIndex: 'checksum', key: 'checksum', render: shortChecksum },
              {
                title: t('Status'),
                dataIndex: 'importable',
                key: 'importable',
                render: (value: boolean) => (
                  <Tag color={value ? 'green' : 'red'}>{value ? t('Importable') : t('Blocked')}</Tag>
                ),
              },
              {
                title: t('Warnings'),
                dataIndex: 'warnings',
                key: 'warnings',
                render: (warnings: string[]) => (warnings.length ? warnings.join(' | ') : '—'),
              },
            ]}
          />
        </Card>
      ) : null}

      {analysis?.groups.length ? (
        <Card
          title={t('Detected import groups')}
          extra={
            <Button type="primary" loading={loading === 'run' || Object.keys(runningGroups).length > 0} onClick={runAllGroups}>
              {t('Run all groups')}
            </Button>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {analysis.groups.map((group) => {
              const key = groupKey(group);
              const result = results[key];
              return (
                <Card key={key} type="inner" title={`${group.adapterName} / ${group.sourceType} / ${group.domain}`}>
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    <Descriptions size="small" column={1}>
                      <Descriptions.Item label={t('Files')}>{group.files.join(', ')}</Descriptions.Item>
                      <Descriptions.Item label={t('Source connection')}>
                        <Select
                          style={{ minWidth: 420 }}
                          value={selectedConnections[key]}
                          options={sourceOptionsForGroup(group)}
                          onChange={(value) => setSelectedConnections((current) => ({ ...current, [key]: value }))}
                          placeholder={t('Choose source connection')}
                        />
                      </Descriptions.Item>
                    </Descriptions>
                    <Space>
                      <Button type="primary" loading={loading === 'run' || Boolean(runningGroups[key])} onClick={() => runGroup(group)}>
                        {runningGroups[key] ? t('Import running') : t('Run import group')}
                      </Button>
                      {sourceOptionsForGroup(group).length === 0 ? (
                        <Button loading={loading === 'run'} onClick={() => createSourceForGroup(group)}>
                          {t('Create matching source connection')}
                        </Button>
                      ) : null}
                    </Space>
                    {result ? (
                      <Alert
                        type={result.status === 'success' || result.status === 'skipped' ? 'success' : 'warning'}
                        showIcon
                        message={`${t('Import run')}: ${result.id ?? '—'} (${result.status ?? 'unknown'})`}
                        description={`${t('Rows')}: ${result.rowCount ?? 0}; ${t('Normalized')}: ${
                          result.normalizedCount ?? 0
                        }; ${t('Warnings')}: ${result.warningCount ?? 0}; ${t('Errors')}: ${result.errorCount ?? 0}${
                          result.errorMessage ? `; ${result.errorMessage}` : ''
                        }`}
                      />
                    ) : null}
                  </Space>
                </Card>
              );
            })}
          </Space>
        </Card>
      ) : null}
    </Space>
  );
}
