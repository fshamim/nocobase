import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Alert, Button, Descriptions, Space, Spin, Typography } from 'antd';
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
  accountId?: string;
  accountLabel?: string;
  expiresAt?: string;
  connectedAt?: string;
  lastVerifiedAt?: string;
  lastError?: string;
  authSession?: DeviceAuthSession | null;
};

type UsageWindow = {
  usedPercent: number;
  remainingPercent: number;
  resetAt?: string;
  resetAfterSeconds?: number;
  limitWindowSeconds?: number;
};

type UsagePayload = {
  usage?: {
    planType?: string;
    fetchedAt: string;
    rateLimit?: {
      primaryWindow?: UsageWindow;
      secondaryWindow?: UsageWindow;
    };
    codeReviewRateLimit?: {
      primaryWindow?: UsageWindow;
      secondaryWindow?: UsageWindow;
    };
    credits?: {
      hasCredits?: boolean;
      unlimited?: boolean;
      balance?: number | string;
      approxLocalMessages?: [number, number];
      approxCloudMessages?: [number, number];
    };
  };
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

function isCancelledRequest(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'CanceledError' || /cancel|abort/i.test(error.message))
  );
}

function formatTimestamp(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatUsageWindow(window: UsageWindow | undefined, fallback: string): string {
  if (!window) {
    return fallback;
  }
  const reset = window.resetAt ? `, resets ${formatTimestamp(window.resetAt, window.resetAt)}` : '';
  return `${window.remainingPercent.toFixed(0)}% remaining (${window.usedPercent.toFixed(0)}% used${reset})`;
}

function nextResetAt(usage: UsagePayload['usage'] | null): string | undefined {
  const resets = [
    usage?.rateLimit?.primaryWindow?.resetAt,
    usage?.codeReviewRateLimit?.primaryWindow?.resetAt,
    usage?.rateLimit?.secondaryWindow?.resetAt,
    usage?.codeReviewRateLimit?.secondaryWindow?.resetAt,
  ]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((value) => Number.isFinite(value) && value > Date.now())
    .sort((left, right) => left - right);
  return resets.length ? new Date(resets[0]).toISOString() : undefined;
}

function usageLimitReached(usage: UsagePayload['usage'] | null): boolean {
  return Boolean(usage?.rateLimit?.limitReached || usage?.codeReviewRateLimit?.limitReached);
}

const OAuthConnectionCard: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const form = useForm();
  const record = useCollectionRecordData<Record<string, unknown>>();
  const { message } = App.useApp();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [usage, setUsage] = useState<UsagePayload['usage'] | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [deviceSession, setDeviceSession] = useState<DeviceAuthSession | null>(null);
  const [loading, setLoading] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const usageAbortRef = useRef<AbortController | null>(null);

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

  const cancelUsage = useCallback(() => {
    usageAbortRef.current?.abort();
    usageAbortRef.current = null;
    setUsageLoading(false);
  }, []);

  const refreshUsage = useCallback(async () => {
    if (!serviceName || mockMode) {
      setUsage(null);
      setUsageError(null);
      return;
    }
    cancelUsage();
    const controller = new AbortController();
    usageAbortRef.current = controller;
    setUsageLoading(true);
    setUsageError(null);
    try {
      const response = await api.resource('codexSubscriptionAuth').usage(
        { values: { llmServiceName: serviceName } },
        { skipNotify: true, signal: controller.signal } as Record<string, unknown>,
      );
      if (controller.signal.aborted) {
        return;
      }
      const payload = getActionPayload<UsagePayload>(response);
      setUsage(payload?.usage ?? null);
    } catch (error) {
      if (isCancelledRequest(error)) {
        return;
      }
      setUsage(null);
      setUsageError(getErrorMessage(error, t('Codex usage check failed')));
    } finally {
      if (usageAbortRef.current === controller) {
        usageAbortRef.current = null;
        setUsageLoading(false);
      }
    }
  }, [api, cancelUsage, mockMode, serviceName, t]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!serviceName || mockMode) {
      setStatus(null);
      setUsage(null);
      setUsageError(null);
      setDeviceSession(null);
      cancelUsage();
      return stopPolling;
    }
    refreshStatus().then((nextStatus) => {
      if (mounted && nextStatus?.connected) {
        refreshUsage();
      }
    });
    return () => {
      mounted = false;
      stopPolling();
      cancelUsage();
    };
  }, [serviceName, mockMode]);

  const startPolling = (authSessionId: string, intervalSeconds: number | undefined) => {
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      const next = await refreshStatus(authSessionId);
      if (!next?.authSession || next.authSession.status === 'pending') {
        if (
          next?.authSession?.intervalSeconds &&
          toPollIntervalMs(next.authSession.intervalSeconds) !== toPollIntervalMs(intervalSeconds)
        ) {
          startPolling(authSessionId, next.authSession.intervalSeconds);
        }
        return;
      }
      stopPolling();
      if (next.authSession.status === 'succeeded') {
        setDeviceSession(null);
        refreshUsage();
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
      cancelUsage();
      setDeviceSession(null);
      setUsage(null);
      setUsageError(null);
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
  const resetAt = nextResetAt(usage);
  const limitReached = usageLimitReached(usage);

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
          {status?.accountId ? (
            <Space direction="vertical" size={0}>
              <Typography.Text copyable>{status.accountId}</Typography.Text>
              {status.accountLabel ? <Typography.Text type="secondary">{status.accountLabel}</Typography.Text> : null}
            </Space>
          ) : (
            <Typography.Text type="secondary">{t('Not connected')}</Typography.Text>
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('Connected at')}>
          {status?.connectedAt ? formatTimestamp(status.connectedAt, status.connectedAt) : <Typography.Text type="secondary">{t('Unknown')}</Typography.Text>}
        </Descriptions.Item>
        <Descriptions.Item label={t('Access expires')}>
          {status?.expiresAt ? formatTimestamp(status.expiresAt, status.expiresAt) : <Typography.Text type="secondary">{t('Unknown')}</Typography.Text>}
        </Descriptions.Item>
        <Descriptions.Item label={t('Last verified')}>
          {status?.lastVerifiedAt ? formatTimestamp(status.lastVerifiedAt, status.lastVerifiedAt) : <Typography.Text type="secondary">{t('Unknown')}</Typography.Text>}
        </Descriptions.Item>
        <Descriptions.Item label={t('Usage reset')}>
          {usageLoading ? (
            <Typography.Text type="secondary">{t('Checking usage…')}</Typography.Text>
          ) : resetAt ? (
            <Space direction="vertical" size={0}>
              <Typography.Text type={limitReached ? 'danger' : undefined}>
                {limitReached ? t('Limit reached') : t('Next reset')} {formatTimestamp(resetAt, resetAt)}
              </Typography.Text>
              <Typography.Text type="secondary">{t('Shown from ChatGPT usage windows')}</Typography.Text>
            </Space>
          ) : status?.connected ? (
            <Typography.Text type="secondary">{usageError || t('Usage reset unavailable')}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">{t('Connect ChatGPT to check usage')}</Typography.Text>
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('Usage health')}>
          {usageLoading ? (
            <Space size="small">
              <Spin size="small" />
              <Typography.Text>{t('Checking usage…')}</Typography.Text>
            </Space>
          ) : usageError ? (
            <Typography.Text type="danger">{usageError}</Typography.Text>
          ) : usage ? (
            <Space direction="vertical" size={0}>
              <Typography.Text>{usage.planType ? `${t('Plan')}: ${usage.planType}` : t('Plan unknown')}</Typography.Text>
              <Typography.Text>{`${t('5h window')}: ${formatUsageWindow(
                usage.rateLimit?.primaryWindow,
                t('Unknown'),
              )}`}</Typography.Text>
              <Typography.Text>{`${t('7d window')}: ${formatUsageWindow(
                usage.rateLimit?.secondaryWindow,
                t('Unknown'),
              )}`}</Typography.Text>
              {usage.codeReviewRateLimit?.primaryWindow ? (
                <Typography.Text>{`${t('Code review')}: ${formatUsageWindow(
                  usage.codeReviewRateLimit.primaryWindow,
                  t('Unknown'),
                )}`}</Typography.Text>
              ) : null}
              {usage.credits ? (
                <Typography.Text>{`${t('Credits')}: ${
                  usage.credits.unlimited
                    ? t('Unlimited')
                    : usage.credits.balance === undefined
                    ? t('Unknown')
                    : usage.credits.balance
                }`}</Typography.Text>
              ) : null}
              <Typography.Text type="secondary">{`${t('Last fetched')}: ${usage.fetchedAt}`}</Typography.Text>
            </Space>
          ) : status?.connected ? (
            <Typography.Text type="secondary">{t('Not checked yet')}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">{t('Connect ChatGPT to check usage')}</Typography.Text>
          )}
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
      {status?.authSession?.status === 'pending' && status.authSession.errorMessage ? (
        <Alert type="warning" showIcon message={status.authSession.errorMessage} />
      ) : null}
      {status?.authSession?.status === 'failed' && status.authSession.errorMessage ? (
        <Alert type="error" showIcon message={status.authSession.errorMessage} />
      ) : null}
      {status?.lastError ? <Alert type="warning" showIcon message={status.lastError} /> : null}
      <Space wrap>
        <Button type="primary" onClick={connect} loading={loading} disabled={mockMode || pending}>
          {status?.connected ? t('Reconnect ChatGPT') : t('Connect ChatGPT')}
        </Button>
        <Button
          onClick={async () => {
            const nextStatus = await refreshStatus();
            if (nextStatus?.connected) {
              refreshUsage();
            }
          }}
          disabled={!serviceName || loading || mockMode}
        >
          {t('Refresh status')}
        </Button>
        <Button onClick={refreshUsage} disabled={!status?.connected || usageLoading || loading || mockMode}>
          {t('Refresh usage')}
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
