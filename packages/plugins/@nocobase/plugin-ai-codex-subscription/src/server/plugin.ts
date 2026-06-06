import { randomUUID } from 'node:crypto';
import { Plugin } from '@nocobase/server';
import { codexSubscriptionProviderOptions } from './llm-providers/codex-subscription';
import {
  CODEX_DEVICE_REDIRECT_URI,
  maskAccountId,
  pollCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from './auth/codex-oauth';
import {
  completeCodexAuthSession,
  createCodexAuthSession,
  deleteCodexCredentials,
  getCodexConnectionStatus,
  loadCodexAuthSessionById,
  loadLatestCodexAuthSessionByService,
  saveCodexCredentials,
} from './auth/store';
import type { StoredCodexAuthSession } from './auth/store';

type AiPlugin = {
  aiManager: {
    registerLLMProvider: (name: string, options: unknown) => void;
  };
};

function getActionValues(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null) {
    return {};
  }
  const values = (params as Record<string, unknown>).values;
  return typeof values === 'object' && values !== null ? (values as Record<string, unknown>) : {};
}

function getRequiredString(values: Record<string, unknown>, key: string, message: string): string {
  const value = values[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected Codex subscription error.';
}

function serializeDeviceAuthStart(authSession: StoredCodexAuthSession) {
  return {
    authSessionId: authSession.id,
    userCode: authSession.userCode,
    verificationUri: authSession.verificationUri,
    intervalSeconds: authSession.intervalSeconds,
    expiresAt: authSession.expiresAt,
  };
}

function serializeAuthSession(authSession: StoredCodexAuthSession | null) {
  if (!authSession) {
    return null;
  }
  return {
    id: authSession.id,
    status: authSession.status,
    errorMessage: authSession.errorMessage,
    userCode: authSession.userCode,
    verificationUri: authSession.verificationUri,
    intervalSeconds: authSession.intervalSeconds,
    expiresAt: authSession.expiresAt,
  };
}

async function verifyCodexService(plugin: PluginAICodexSubscriptionServer, llmServiceName: string): Promise<void> {
  const llmService = await plugin.app.db.getRepository('llmServices').findOne({ filter: { name: llmServiceName } });
  if (!llmService) {
    throw new Error(`Codex subscription auth failed: LLM service ${llmServiceName} does not exist.`);
  }
  const provider =
    typeof llmService.get === 'function'
      ? llmService.get('provider')
      : (llmService as Record<string, unknown>).provider;
  if (provider !== 'codex-subscription') {
    throw new Error(
      `Codex subscription auth failed: LLM service ${llmServiceName} is not a codex-subscription service.`,
    );
  }
}

async function completePendingDeviceSession(
  plugin: PluginAICodexSubscriptionServer,
  authSession: StoredCodexAuthSession,
): Promise<void> {
  if (authSession.status !== 'pending') {
    return;
  }
  const expiresAt = Date.parse(authSession.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    await completeCodexAuthSession(plugin.app, authSession.id, {
      status: 'failed',
      errorMessage: 'Codex device-code login expired. Start a new connection and try again.',
    });
    return;
  }

  try {
    const result = await pollCodexDeviceAuthorization({
      deviceAuthId: authSession.deviceAuthId,
      userCode: authSession.userCode,
    });
    if (result.status === 'pending') {
      return;
    }
    await saveCodexCredentials(plugin.app, {
      llmServiceName: authSession.llmServiceName,
      accountId: result.token.accountId,
      accessToken: result.token.access,
      refreshToken: result.token.refresh,
      expiresAt: result.token.expiresAt,
      lastVerifiedAt: new Date().toISOString(),
    });
    await completeCodexAuthSession(plugin.app, authSession.id, { status: 'succeeded' });
  } catch (error) {
    await completeCodexAuthSession(plugin.app, authSession.id, {
      status: 'failed',
      errorMessage: safeErrorMessage(error),
    });
  }
}

export class PluginAICodexSubscriptionServer extends Plugin {
  async load() {
    this.aiPlugin.aiManager.registerLLMProvider('codex-subscription', codexSubscriptionProviderOptions);

    this.app.resourceManager.define({
      name: 'codexSubscriptionAuth',
      actions: {
        begin: async (ctx, next) => {
          try {
            const values = getActionValues(ctx.action.params);
            const llmServiceName = getRequiredString(
              values,
              'llmServiceName',
              'Codex subscription auth failed: llmServiceName is required.',
            );
            await verifyCodexService(this, llmServiceName);
            let latestAuthSession = await loadLatestCodexAuthSessionByService(this.app, llmServiceName);
            if (latestAuthSession?.status === 'pending') {
              await completePendingDeviceSession(this, latestAuthSession);
              latestAuthSession = await loadCodexAuthSessionById(this.app, latestAuthSession.id);
            }
            if (latestAuthSession?.status === 'pending') {
              ctx.body = serializeDeviceAuthStart(latestAuthSession);
              await next();
              return;
            }

            const device = await startCodexDeviceAuthorization();
            const authSessionId = randomUUID();
            await createCodexAuthSession(this.app, {
              id: authSessionId,
              llmServiceName,
              state: authSessionId,
              deviceAuthId: device.deviceAuthId,
              userCode: device.userCode,
              verificationUri: device.verificationUri,
              intervalSeconds: device.intervalSeconds,
              expiresAt: device.expiresAt,
              redirectUri: CODEX_DEVICE_REDIRECT_URI,
              status: 'pending',
            });
            ctx.body = serializeDeviceAuthStart({
              id: authSessionId,
              llmServiceName,
              state: authSessionId,
              deviceAuthId: device.deviceAuthId,
              userCode: device.userCode,
              verificationUri: device.verificationUri,
              intervalSeconds: device.intervalSeconds,
              expiresAt: device.expiresAt,
              redirectUri: CODEX_DEVICE_REDIRECT_URI,
              status: 'pending',
            });
          } catch (error) {
            ctx.throw(400, safeErrorMessage(error));
            return;
          }
          await next();
        },
        status: async (ctx, next) => {
          try {
            const values = getActionValues(ctx.action.params);
            const llmServiceName = getRequiredString(
              values,
              'llmServiceName',
              'Codex subscription auth failed: llmServiceName is required.',
            );
            const authSessionId = typeof values.authSessionId === 'string' ? values.authSessionId : undefined;
            let authSession = authSessionId
              ? await loadCodexAuthSessionById(this.app, authSessionId)
              : await loadLatestCodexAuthSessionByService(this.app, llmServiceName);
            if (authSession?.llmServiceName !== llmServiceName) {
              authSession = null;
            }
            if (authSession?.status === 'pending') {
              await completePendingDeviceSession(this, authSession);
              authSession = await loadCodexAuthSessionById(this.app, authSession.id);
            }
            const connection = await getCodexConnectionStatus(this.app, llmServiceName);
            ctx.body = {
              ...connection,
              authSession: serializeAuthSession(authSession),
            };
          } catch (error) {
            ctx.throw(400, safeErrorMessage(error));
            return;
          }
          await next();
        },
        disconnect: async (ctx, next) => {
          try {
            const values = getActionValues(ctx.action.params);
            const llmServiceName = getRequiredString(
              values,
              'llmServiceName',
              'Codex subscription disconnect failed: llmServiceName is required.',
            );
            await deleteCodexCredentials(this.app, llmServiceName);
            ctx.body = { llmServiceName, connected: false };
          } catch (error) {
            ctx.throw(400, safeErrorMessage(error));
            return;
          }
          await next();
        },
      },
    });

    this.app.acl.allow('codexSubscriptionAuth', ['begin', 'status', 'disconnect'], 'loggedIn');
  }

  private get aiPlugin(): AiPlugin {
    const plugin = this.app.pm.get('ai') as unknown as AiPlugin | undefined;
    if (!plugin?.aiManager) {
      throw new Error('Codex subscription plugin requires @nocobase/plugin-ai to be enabled.');
    }
    return plugin;
  }
}

export default PluginAICodexSubscriptionServer;
