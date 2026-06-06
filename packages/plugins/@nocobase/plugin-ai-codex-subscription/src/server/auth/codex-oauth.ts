const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
export const CODEX_DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
export const CODEX_DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

export type CodexOAuthToken = {
  access: string;
  refresh: string;
  expiresAt: string;
  accountId: string;
};

export type CodexDeviceAuthorization = {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: string;
};

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type DeviceUserCodeResponse = {
  device_auth_id?: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
};

type DeviceTokenResponse = {
  authorization_code?: string;
  code_verifier?: string;
};

type DevicePollResult =
  | { status: 'pending' }
  | {
      status: 'succeeded';
      token: CodexOAuthToken;
    };

type JwtPayload = {
  [JWT_CLAIM_PATH]?: {
    chatgpt_account_id?: string;
  };
  [key: string]: unknown;
};

export async function startCodexDeviceAuthorization(): Promise<CodexDeviceAuthorization> {
  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(describeOpenAiDeviceHttpError('start', response.status, body));
  }

  const payload = (await response.json()) as DeviceUserCodeResponse | null;
  const deviceAuthId = payload?.device_auth_id;
  const userCode = payload?.user_code ?? payload?.usercode;
  if (!deviceAuthId || !userCode) {
    throw new Error('Codex device-code start response was missing required fields.');
  }

  return {
    deviceAuthId,
    userCode,
    verificationUri: CODEX_DEVICE_VERIFICATION_URI,
    intervalSeconds: normalizeIntervalSeconds(payload.interval),
    expiresAt: new Date(Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000).toISOString(),
  };
}

export async function pollCodexDeviceAuthorization(input: {
  deviceAuthId: string;
  userCode: string;
}): Promise<DevicePollResult> {
  const response = await fetch(DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_auth_id: input.deviceAuthId,
      user_code: input.userCode,
    }),
  });

  if (response.ok) {
    const payload = (await response.json()) as DeviceTokenResponse | null;
    if (!payload?.authorization_code || !payload.code_verifier) {
      throw new Error('Codex device-code token response was missing required fields.');
    }
    return {
      status: 'succeeded',
      token: await exchangeCodexAuthorizationCode({
        code: payload.authorization_code,
        verifier: payload.code_verifier,
        redirectUri: CODEX_DEVICE_REDIRECT_URI,
      }),
    };
  }

  const body = await response.text().catch(() => '');
  const errorCode = parseErrorCode(body);
  if (
    response.status === 403 ||
    response.status === 404 ||
    errorCode === 'deviceauth_authorization_pending' ||
    errorCode === 'slow_down'
  ) {
    return { status: 'pending' };
  }

  throw new Error(describeOpenAiDeviceHttpError('poll', response.status, body));
}

export async function exchangeCodexAuthorizationCode(input: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<CodexOAuthToken> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    }),
  });
  return parseTokenResponse(response, 'exchange');
}

export async function refreshCodexAccessToken(refreshToken: string): Promise<CodexOAuthToken> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  return parseTokenResponse(response, 'refresh');
}

export function maskAccountId(accountId: string | undefined): string | undefined {
  if (!accountId) {
    return undefined;
  }
  if (accountId.length <= 8) {
    return accountId;
  }
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}

async function parseTokenResponse(response: Response, operation: 'exchange' | 'refresh'): Promise<CodexOAuthToken> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Codex OAuth ${operation} failed with status ${response.status}${body ? `: ${body}` : ''}.`);
  }

  const payload = (await response.json()) as OAuthTokenResponse | null;
  if (!payload?.access_token || !payload.refresh_token || typeof payload.expires_in !== 'number') {
    throw new Error(`Codex OAuth ${operation} response was missing required fields.`);
  }

  const accountId = extractChatGptAccountId(payload.access_token);
  if (!accountId) {
    throw new Error('Codex OAuth token did not include a ChatGPT account id.');
  }

  return {
    access: payload.access_token,
    refresh: payload.refresh_token,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
    accountId,
  };
}

export function extractChatGptAccountId(accessToken: string): string | undefined {
  const payload = decodeJwt(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

function describeOpenAiDeviceHttpError(operation: 'start' | 'poll', status: number, body: string): string {
  if (status === 429) {
    return `Codex device-code ${operation} was rate-limited or challenged by OpenAI (HTTP 429). Wait a few minutes before requesting another code; if a code is already visible, complete that code instead.`;
  }
  if (status === 404) {
    return `Codex device-code ${operation} is unavailable from OpenAI (HTTP 404). Verify device-code authentication is enabled for the ChatGPT workspace.`;
  }
  const bodySummary = summarizeHttpErrorBody(body);
  return `Codex device-code ${operation} failed with status ${status}${bodySummary ? `: ${bodySummary}` : ''}.`;
}

function summarizeHttpErrorBody(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (/<!doctype|<html/i.test(normalized)) {
    return 'OpenAI returned an HTML challenge/error page.';
  }
  return normalized.length > 500 ? `${normalized.slice(0, 500)}…` : normalized;
}

function normalizeIntervalSeconds(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEVICE_POLL_INTERVAL_SECONDS;
}

function parseErrorCode(body: string): string | undefined {
  try {
    const payload = JSON.parse(body) as { error?: string | { code?: string } } | null;
    const error = payload?.error;
    return typeof error === 'string' ? error : error?.code;
  } catch {
    return undefined;
  }
}

function decodeJwt(token: string): JwtPayload | null {
  try {
    const [, rawPayload] = token.split('.');
    if (!rawPayload) {
      return null;
    }
    return JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
}
