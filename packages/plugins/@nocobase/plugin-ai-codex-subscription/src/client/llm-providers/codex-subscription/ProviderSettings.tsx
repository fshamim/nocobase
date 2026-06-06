import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Alert, Button, Descriptions, Space, Typography } from 'antd';
import { useAPIClient, useCollectionRecordData } from '@nocobase/client';
import { useForm } from '@formily/react';
import { SchemaComponent } from '@nocobase/client';
import { tval } from '@nocobase/utils/client';
import { namespace, useT } from '../../locale';

type DeviceAuthSession = {
  id: string;
  status: 'pending' | 'succeeded' | 'failed';
  errorMessage?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresAt?: string;
};

type AuthStatus = {
  connected: boolean;
  accountLabel?: string;
  expiresAt?: string;
  connectedAt?: string;
  lastVerifiedAt?: string;
  authSession?: DeviceAuthSession | null;
};

type BeginDeviceAuthPayload = {
  authSessionId?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresAt?: string;
};

const DEFAULT_AUTH_POLL_INTERVAL_MS = 5000;

function getActionPayload<T>(response: { data?: { data?: T | { data?: T } } } | undefined): T | undefined {
  const payload = response?.data?.data;
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data?: T }).data;
  }
  return payload as T | undefined;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: { data?: { errors?: Array<{ message?: string }> } } }).response;
    const message = response?.data?.errors?.[0]?.message;
    if (message) {
      return message;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function toPollIntervalMs(intervalSeconds: number | undefined): number {
  if (!intervalSeconds || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return DEFAULT_AUTH_POLL_INTERVAL_MS;
  }
  return Math.max(intervalSeconds * 1000, 2000);
}

const OAuthConnectionCard: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const form = useForm();
  const record = useCollectionRecordData<Record<string, unknown>>();
  const { message } = App.useApp();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [deviceSession, setDeviceSession] = useState<DeviceAuthSession | null>(null);
  const [loading, setLoading] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const serviceName = useMemo(() => {
    const formName = typeof form.values?.name === 'string' ? form.values.name : undefined;
    const recordName = typeof record?.name === 'string' ? record.name : undefined;
    return (formName || recordName || '').trim();
  }, [form.values?.name, record?.name]);

  const mockMode = form.values?.options?.mockMode === true;

  useEffect(() => {
    form.setValuesIn?.('options.apiKey', 'oauth-managed');
    if (serviceName) {
      form.setValuesIn?.('options.llmServiceName', serviceName);
    }
  }, [form, serviceName]);

  const refreshStatus = useCallback(
    async (authSessionId?: string) => {
      if (!serviceName) {
        return;
      }
      const response = await api
        .resource('codexSubscriptionAuth')
        .status({ values: { llmServiceName: serviceName, authSessionId } }, { skipNotify: true });
      const nextStatus = getActionPayload<AuthStatus>(response) ?? null;
      setStatus(nextStatus);
      if (nextStatus?.authSession) {
        setDeviceSession(nextStatus.authSession);
      }
      return nextStatus ?? undefined;
    },
    [api, serviceName],
  );

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!serviceName || mockMode) {
      setStatus(null);
      setDeviceSession(null);
      return;
    }
    refreshStatus();
    return stopPolling;
  }, [mockMode, refreshStatus, serviceName, stopPolling]);

  const startPolling = (authSessionId: string, intervalSeconds: number | undefined) => {
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      const next = await refreshStatus(authSessionId);
      if (!next?.authSession || next.authSession.status === 'pending') {
        return;
      }
      stopPolling();
      if (next.authSession.status === 'succeeded') {
        setDeviceSession(null);
        message.success(t('ChatGPT connection completed'));
      } else {
        message.error(next.authSession.errorMessage || t('ChatGPT connection failed'));
      }
    }, toPollIntervalMs(intervalSeconds));
  };

  const connect = async () => {
    if (!serviceName) {
      message.warning(t('Save this LLM service before connecting ChatGPT'));
      return;
    }
    setLoading(true);
    try {
      const response = await api
        .resource('codexSubscriptionAuth')
        .begin({ values: { llmServiceName: serviceName } }, { skipNotify: true });
      const payload = getActionPayload<BeginDeviceAuthPayload>(response);
      if (!payload?.authSessionId || !payload.userCode || !payload.verificationUri) {
        throw new Error(t('Codex device-code start response was incomplete'));
      }
      const nextDeviceSession = {
        id: payload.authSessionId,
        status: 'pending' as const,
        userCode: payload.userCode,
        verificationUri: payload.verificationUri,
        intervalSeconds: payload.intervalSeconds,
        expiresAt: payload.expiresAt,
      };
      setDeviceSession(nextDeviceSession);
      await refreshStatus(payload.authSessionId);
      startPolling(payload.authSessionId, payload.intervalSeconds);
      message.info(t('Enter the device code in OpenAI, then wait for NocoBase to connect.'));
    } catch (error) {
      message.error(getErrorMessage(error, t('ChatGPT connection failed')));
    } finally {
      setLoading(false);
    }
  };

  const disconnect = async () => {
    if (!serviceName) {
      return;
    }
    setLoading(true);
    try {
      await api
        .resource('codexSubscriptionAuth')
        .disconnect({ values: { llmServiceName: serviceName } }, { skipNotify: true });
      stopPolling();
      setDeviceSession(null);
      await refreshStatus();
      message.success(t('ChatGPT connection removed'));
    } catch (error) {
      message.error(getErrorMessage(error, t('Failed to remove ChatGPT connection')));
    } finally {
      setLoading(false);
    }
  };

  const pending = status?.authSession?.status === 'pending' || deviceSession?.status === 'pending';
  const activeDeviceSession = deviceSession?.status === 'pending' ? deviceSession : status?.authSession;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={t('Connect a real ChatGPT subscription')}
        description={t(
          'This provider uses OpenAI Codex device-code login, stores the resulting tokens encrypted inside NocoBase, and uses them directly for Codex requests. No bridge URL, popup callback, or pasted session secret is required.',
        )}
      />
      {mockMode ? (
        <Alert
          type="warning"
          showIcon
          message={t('Mock mode is enabled')}
          description={t('Disable mock mode before connecting a live ChatGPT subscription.')}
        />
      ) : null}
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label={t('LLM service')}>{serviceName || t('Unsaved')}</Descriptions.Item>
        <Descriptions.Item label={t('Status')}>
          {pending ? t('Waiting for device-code login…') : status?.connected ? t('Connected') : t('Disconnected')}
        </Descriptions.Item>
        <Descriptions.Item label={t('ChatGPT account')}>
          {status?.accountLabel || <Typography.Text type="secondary">{t('Not connected')}</Typography.Text>}
        </Descriptions.Item>
        <Descriptions.Item label={t('Access expires')}>
          {status?.expiresAt || <Typography.Text type="secondary">{t('Unknown')}</Typography.Text>}
        </Descriptions.Item>
      </Descriptions>
      {activeDeviceSession?.status === 'pending' &&
      activeDeviceSession.userCode &&
      activeDeviceSession.verificationUri ? (
        <Alert
          type="success"
          showIcon
          message={t('Complete device-code login')}
          description={
            <Space direction="vertical" size="small">
              <Typography.Text>{t('Open the OpenAI device page and enter this code:')}</Typography.Text>
              <Typography.Title level={3} style={{ margin: 0, letterSpacing: 2 }}>
                {activeDeviceSession.userCode}
              </Typography.Title>
              <Typography.Link href={activeDeviceSession.verificationUri} target="_blank" rel="noreferrer">
                {activeDeviceSession.verificationUri}
              </Typography.Link>
              {activeDeviceSession.expiresAt ? (
                <Typography.Text type="secondary">
                  {t('Code expires at')} {activeDeviceSession.expiresAt}
                </Typography.Text>
              ) : null}
            </Space>
          }
        />
      ) : null}
      {status?.authSession?.status === 'failed' && status.authSession.errorMessage ? (
        <Alert type="error" showIcon message={status.authSession.errorMessage} />
      ) : null}
      <Space wrap>
        <Button type="primary" onClick={connect} loading={loading} disabled={mockMode || pending}>
          {status?.connected ? t('Reconnect ChatGPT') : t('Connect ChatGPT')}
        </Button>
        <Button onClick={() => refreshStatus()} disabled={!serviceName || loading || mockMode}>
          {t('Refresh status')}
        </Button>
        <Button danger onClick={disconnect} disabled={!status?.connected || loading || pending}>
          {t('Disconnect')}
        </Button>
      </Space>
    </Space>
  );
};

export const ProviderSettingsForm: React.FC = () => {
  return (
    <SchemaComponent
      components={{ OAuthConnectionCard }}
      schema={{
        type: 'void',
        properties: {
          auth: {
            type: 'void',
            'x-component': 'OAuthConnectionCard',
          },
          apiKey: {
            title: tval('Compatibility API key sentinel', { ns: namespace }),
            description: tval(
              'Set automatically so the current NocoBase test-flight UI can run. The provider ignores this value.',
              {
                ns: namespace,
              },
            ),
            type: 'string',
            default: 'oauth-managed',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            'x-hidden': true,
          },
          llmServiceName: {
            title: tval('LLM service name', { ns: namespace }),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            'x-hidden': true,
          },
          mockMode: {
            title: tval('Mock mode', { ns: namespace }),
            description: tval('Use for tests and local setup without a live ChatGPT subscription.', { ns: namespace }),
            type: 'boolean',
            default: false,
            'x-decorator': 'FormItem',
            'x-component': 'Checkbox',
          },
          mockResponse: {
            title: tval('Mock response', { ns: namespace }),
            type: 'string',
            'x-decorator': 'FormItem',
            'x-component': 'Input.TextArea',
          },
        },
      }}
    />
  );
};
