import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_DEVICE_VERIFICATION_URI,
  extractChatGptAccountId,
  maskAccountId,
  pollCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from '../auth/codex-oauth';

function createJwt(accountId: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Codex OAuth helpers', () => {
  it('starts the OpenAI Codex device-code flow', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
      return new Response(
        JSON.stringify({ device_auth_id: 'device-session-1', user_code: 'ABCD-1234', interval: '7' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const flow = await startCodexDeviceAuthorization();

    expect(flow).toMatchObject({
      deviceAuthId: 'device-session-1',
      userCode: 'ABCD-1234',
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: 7,
    });
    expect(Date.parse(flow.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('reports OpenAI device-code rate limits without leaking HTML challenge bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('<!DOCTYPE html><html><title>Just a moment...</title></html>', { status: 429 });
      }),
    );

    await expect(startCodexDeviceAuthorization()).rejects.toThrow(
      'Codex device-code start was rate-limited or challenged by OpenAI (HTTP 429). Wait a few minutes before requesting another code; if a code is already visible, complete that code instead.',
    );
  });

  it('keeps device-code polling pending while OpenAI has not authorized the code', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { code: 'deviceauth_authorization_pending' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pollCodexDeviceAuthorization({ deviceAuthId: 'device-session-1', userCode: 'ABCD-1234' }),
    ).resolves.toEqual({ status: 'pending' });
  });

  it('exchanges completed device-code authorization for OAuth credentials', async () => {
    const accessToken = createJwt('acct_test_12345678');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          device_auth_id: 'device-session-1',
          user_code: 'ABCD-1234',
        });
        return new Response(JSON.stringify({ authorization_code: 'auth-code-1', code_verifier: 'verifier-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      expect(url).toBe('https://auth.openai.com/oauth/token');
      const body = String(init?.body);
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=auth-code-1');
      expect(body).toContain('code_verifier=verifier-1');
      expect(body).toContain('redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback');
      return new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh-token-1',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      pollCodexDeviceAuthorization({ deviceAuthId: 'device-session-1', userCode: 'ABCD-1234' }),
    ).resolves.toMatchObject({
      status: 'succeeded',
      token: {
        accountId: 'acct_test_12345678',
        access: accessToken,
        refresh: 'refresh-token-1',
      },
    });
  });

  it('extracts and masks the ChatGPT account id from the OAuth access token', () => {
    const token = createJwt('acct_test_12345678');
    expect(extractChatGptAccountId(token)).toBe('acct_test_12345678');
    expect(maskAccountId('acct_test_12345678')).toBe('acct…5678');
  });
});
