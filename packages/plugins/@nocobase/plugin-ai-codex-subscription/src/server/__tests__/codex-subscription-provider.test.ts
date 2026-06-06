import { tool } from 'langchain';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexSubscriptionCredentialBlockedError,
  CodexSubscriptionProvider,
} from '../llm-providers/codex-subscription';
import { loadLatestCodexAuthSessionByService, saveCodexCredentials } from '../auth/store';
import { extractChatGptAccountId } from '../auth/codex-oauth';

const { createAgent } = require('langchain') as typeof import('langchain');

type RepositoryRecord = Record<string, unknown> & {
  get?: (key?: string) => unknown;
  update?: (values: Record<string, unknown>) => Promise<void>;
  destroy?: () => Promise<void>;
};

function createRecord(store: RepositoryRecord[], values: Record<string, unknown>): RepositoryRecord {
  const record: RepositoryRecord = { ...values };
  record.get = (key?: string) => (key ? record[key] : record);
  record.update = async (next) => {
    Object.assign(record, next);
  };
  record.destroy = async () => {
    const index = store.indexOf(record);
    if (index >= 0) {
      store.splice(index, 1);
    }
  };
  return record;
}

function createRepository(store: RepositoryRecord[]) {
  return {
    async findOne({ filter, sort }: { filter: Record<string, unknown>; sort?: string[] }) {
      const matches = store.filter((record) => Object.entries(filter).every(([key, value]) => record[key] === value));
      if (sort?.[0] === '-createdAt') {
        matches.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      }
      return matches[0] ?? null;
    },
    async create({ values }: { values: Record<string, unknown> }) {
      const record = createRecord(store, values);
      store.push(record);
      return record;
    },
    async destroy({ filter }: { filter: Record<string, unknown> }) {
      const index = store.findIndex((record) => Object.entries(filter).every(([key, value]) => record[key] === value));
      if (index >= 0) {
        store.splice(index, 1);
      }
    },
  };
}

function createJwt(accountId: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

function createApp() {
  const connections: RepositoryRecord[] = [];
  const authSessions: RepositoryRecord[] = [];
  const app = {
    environment: { renderJsonTemplate: (value: unknown) => value },
    aesEncryptor: {
      encrypt: async (value: string) => `enc:${value}`,
      decrypt: async (value: string) => value.replace(/^enc:/, ''),
    },
    db: {
      getRepository: (name: string) => {
        if (name === 'codexSubscriptionConnections') {
          return createRepository(connections);
        }
        if (name === 'codexSubscriptionAuthSessions') {
          return createRepository(authSessions);
        }
        throw new Error(`Unexpected repository: ${name}`);
      },
    },
  };
  return { app, connections, authSessions };
}

function provider(
  app: ReturnType<typeof createApp>['app'],
  serviceOptions: Record<string, unknown>,
  modelOptions: Record<string, unknown> = { model: 'gpt-5.5' },
) {
  return new CodexSubscriptionProvider({ app: app as any, serviceOptions, modelOptions });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Codex subscription provider', () => {
  it('returns deterministic mock responses without live OAuth credentials', async () => {
    const { app } = createApp();
    const llm = provider(app, { mockMode: true, mockResponse: 'mocked answer' });

    expect(await llm.listModels()).toEqual({ models: [{ id: 'codex-subscription-mock' }] });
    await expect(llm.chatModel.invoke([{ role: 'user', content: 'hello' }])).resolves.toMatchObject({
      content: 'mocked answer',
      response_metadata: { provider: 'codex-subscription', credentialMode: 'mock' },
    });
    await expect(llm.testFlight()).resolves.toEqual({ status: 'success', code: 0 });
  });

  it('is accepted by LangChain agents when AI employees bind tools', async () => {
    const { app } = createApp();
    const llm = provider(app, { mockMode: true, mockResponse: 'CODEX_CONNECTION_OK' });
    const agent = createAgent({
      model: llm.createModel(),
      tools: [tool(async () => 'ok', { name: 'noop_tool', description: 'noop', schema: z.object({}) })],
      systemPrompt: 'Reply exactly CODEX_CONNECTION_OK',
    });

    await expect(
      agent.invoke({ messages: [{ role: 'user', content: 'Reply exactly: CODEX_CONNECTION_OK' }] }),
    ).resolves.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ content: 'CODEX_CONNECTION_OK' })]),
    });
  });

  it('reports explicit connect-first errors when the service is not linked to ChatGPT yet', async () => {
    const { app } = createApp();
    const llm = provider(app, { llmServiceName: 'service-alpha' });

    await expect(llm.chatModel.invoke([{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'Codex subscription provider credential-blocked: connect service-alpha to ChatGPT first.',
    );
    await expect(llm.chatModel.invoke([{ role: 'user', content: 'hello' }])).rejects.toBeInstanceOf(
      CodexSubscriptionCredentialBlockedError,
    );
    expect(await llm.listModels()).toEqual({
      models: [
        { id: 'gpt-5.5' },
        { id: 'gpt-5.4' },
        { id: 'gpt-5.4-mini' },
        { id: 'openai-codex' },
        { id: 'service-alpha' },
      ],
    });
  });

  it('sends direct Codex requests with stored OAuth credentials', async () => {
    const { app } = createApp();
    await saveCodexCredentials(app as any, {
      llmServiceName: 'service-alpha',
      accountId: 'acct_live_12345678',
      accessToken: createJwt('acct_live_12345678'),
      refreshToken: 'refresh-live',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output_text: 'live answer',
          echoedModel: body.model,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const llm = provider(app, { llmServiceName: 'service-alpha' }, { model: 'gpt-5.4', responseFormat: 'json_object' });

    await expect(llm.chatModel.invoke([{ role: 'user', content: 'hello live' }])).resolves.toMatchObject({
      content: 'live answer',
      response_metadata: { credentialMode: 'oauth', model: 'gpt-5.4' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(init.headers).toMatchObject({
      Authorization: expect.stringContaining('Bearer '),
      'chatgpt-account-id': 'acct_live_12345678',
      'OpenAI-Beta': 'responses=experimental',
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.4',
      stream: true,
      instructions: 'Return a valid JSON object.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello live' }] }],
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });
  });

  it('extracts text from Codex SSE output item events', async () => {
    const { app } = createApp();
    await saveCodexCredentials(app as any, {
      llmServiceName: 'service-alpha',
      accountId: 'acct_live_12345678',
      accessToken: createJwt('acct_live_12345678'),
      refreshToken: 'refresh-live',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const event = {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [{ type: 'output_text', text: 'sse item answer' }],
          },
        };
        return new Response(
          `event: response.output_item.done\ndata: ${JSON.stringify(event)}\n\nevent: done\ndata: [DONE]\n`,
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          },
        );
      }),
    );

    const llm = provider(app, { llmServiceName: 'service-alpha' });
    await expect(llm.chatModel.invoke([{ role: 'user', content: 'hello stream' }])).resolves.toMatchObject({
      content: 'sse item answer',
    });
  });

  it('refreshes expired access tokens before making the live request', async () => {
    const { app, connections } = createApp();
    await saveCodexCredentials(app as any, {
      llmServiceName: 'service-alpha',
      accountId: 'acct_old_12345678',
      accessToken: createJwt('acct_old_12345678'),
      refreshToken: 'refresh-old',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const refreshedAccessToken = createJwt('acct_new_87654321');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://auth.openai.com/oauth/token') {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        expect(String(init?.body)).toContain('refresh_token=refresh-old');
        return new Response(
          JSON.stringify({
            access_token: refreshedAccessToken,
            refresh_token: 'refresh-new',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ output_text: 'refreshed answer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const llm = provider(app, { llmServiceName: 'service-alpha' });
    await expect(llm.chatModel.invoke([{ role: 'user', content: 'hello refreshed' }])).resolves.toMatchObject({
      content: 'refreshed answer',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(extractChatGptAccountId(refreshedAccessToken)).toBe('acct_new_87654321');
    expect(connections[0].accountId).toBe('acct_new_87654321');
    expect(String(connections[0].refreshTokenEncrypted)).toBe('enc:refresh-new');
  });

  it('loads the latest device auth session for a service after page refresh', async () => {
    const { app, authSessions } = createApp();
    authSessions.push(
      createRecord(authSessions, {
        id: 'old-session',
        llmServiceName: 'service-alpha',
        state: 'old-session',
        verifierEncrypted: 'enc:old-device',
        userCode: 'OLD-CODE',
        verificationUri: 'https://auth.openai.com/codex/device',
        intervalSeconds: 5,
        expiresAt: '2026-06-06T00:00:00.000Z',
        redirectUri: 'https://auth.openai.com/deviceauth/callback',
        status: 'failed',
        createdAt: '2026-06-06T00:00:00.000Z',
      }),
      createRecord(authSessions, {
        id: 'new-session',
        llmServiceName: 'service-alpha',
        state: 'new-session',
        verifierEncrypted: 'enc:new-device',
        userCode: 'NEW-CODE',
        verificationUri: 'https://auth.openai.com/codex/device',
        intervalSeconds: 5,
        expiresAt: '2026-06-06T00:15:00.000Z',
        redirectUri: 'https://auth.openai.com/deviceauth/callback',
        status: 'pending',
        createdAt: '2026-06-06T00:01:00.000Z',
      }),
    );

    await expect(loadLatestCodexAuthSessionByService(app as any, 'service-alpha')).resolves.toMatchObject({
      id: 'new-session',
      deviceAuthId: 'new-device',
      userCode: 'NEW-CODE',
      status: 'pending',
    });
  });

  it('redacts bearer material in provider error output', () => {
    const { app } = createApp();
    const llm = provider(app, { llmServiceName: 'service-alpha' });
    expect(llm.parseResponseError(new Error('Authorization: Bearer secret-token-value failed'))).toBe(
      'Authorization: Bearer [REDACTED] failed',
    );
  });
});
