const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
export const CODEX_DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_USAGE_TIMEOUT_MS = 15_000;
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

export type CodexUsageWindow = {
  usedPercent: number;
  remainingPercent: number;
  resetAt?: string;
  resetAfterSeconds?: number;
  limitWindowSeconds?: number;
};

export type CodexUsageSnapshot = {
  planType?: string;
  fetchedAt: string;
  rateLimit?: {
    allowed?: boolean;
    limitReached?: boolean;
    primaryWindow?: CodexUsageWindow;
    secondaryWindow?: CodexUsageWindow;
  };
  codeReviewRateLimit?: {
    allowed?: boolean;
    limitReached?: boolean;
    primaryWindow?: CodexUsageWindow;
    secondaryWindow?: CodexUsageWindow;
  };
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: number | string;
    approxLocalMessages?: [number, number];
    approxCloudMessages?: [number, number];
  };
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
  | { status: 'pending'; errorMessage?: string; retryAfterSeconds?: number }
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

export class CodexUsageAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexUsageAuthError';
  }
}

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
  if (response.status === 429) {
    return {
      status: 'pending',
      errorMessage: describeOpenAiDeviceHttpError('poll', response.status, body),
      retryAfterSeconds: readRetryAfterSeconds(response.headers) ?? 60,
    };
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
  return parseTokenResponse(response, 'refresh', refreshToken);
}

export async function fetchCodexUsage(input: {
  accessToken: string;
  accountId: string;
  signal?: AbortSignal;
}): Promise<CodexUsageSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('usage-timeout'), DEFAULT_USAGE_TIMEOUT_MS);
  input.signal?.addEventListener('abort', () => controller.abort('client-aborted'), { once: true });

  let response: Response;
  try {
    response = await fetch(CODEX_USAGE_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'ChatGPT-Account-Id': input.accountId,
        'User-Agent': 'nocobase-codex-subscription',
      },
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Codex usage check timed out after ${DEFAULT_USAGE_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const body = await response.text().catch(() => '');
  if (!response.ok) {
    const message = describeCodexUsageHttpError(response.status, body);
    if (response.status === 401 || response.status === 403) {
      throw new CodexUsageAuthError(message);
    }
    throw new Error(message);
  }

  const payload = body ? parseJsonObject(body) : {};
  return normalizeUsageSnapshot(payload);
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

async function parseTokenResponse(
  response: Response,
  operation: 'exchange' | 'refresh',
  fallbackRefreshToken?: string,
): Promise<CodexOAuthToken> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Codex OAuth ${operation} failed with status ${response.status}${body ? `: ${summarizeHttpErrorBody(body)}` : ''}.`);
  }

  const payload = (await response.json()) as OAuthTokenResponse | null;
  const refreshToken = payload?.refresh_token ?? fallbackRefreshToken;
  if (!payload?.access_token || !refreshToken || typeof payload.expires_in !== 'number') {
    throw new Error(`Codex OAuth ${operation} response was missing required fields.`);
  }

  const accountId = extractChatGptAccountId(payload.access_token);
  if (!accountId) {
    throw new Error('Codex OAuth token did not include a ChatGPT account id.');
  }

  return {
    access: payload.access_token,
    refresh: refreshToken,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
    accountId,
  };
}

export function extractChatGptAccountId(accessToken: string): string | undefined {
  const payload = decodeJwt(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

function normalizeUsageSnapshot(payload: Record<string, unknown>): CodexUsageSnapshot {
  return {
    planType: typeof payload.plan_type === 'string' ? payload.plan_type : undefined,
    fetchedAt: new Date().toISOString(),
    rateLimit: normalizeUsageRateLimit(payload.rate_limit),
    codeReviewRateLimit: normalizeUsageRateLimit(payload.code_review_rate_limit),
    credits: normalizeCredits(payload.credits),
  };
}

function normalizeUsageRateLimit(value: unknown): CodexUsageSnapshot['rateLimit'] {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    allowed: typeof record.allowed === 'boolean' ? record.allowed : undefined,
    limitReached: typeof record.limit_reached === 'boolean' ? record.limit_reached : undefined,
    primaryWindow: normalizeUsageWindow(record.primary_window),
    secondaryWindow: normalizeUsageWindow(record.secondary_window),
  };
}

function normalizeUsageWindow(value: unknown): CodexUsageWindow | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const usedPercent = asFiniteNumber(record.used_percent);
  if (usedPercent === undefined) {
    return undefined;
  }
  const resetAtSeconds = asFiniteNumber(record.reset_at);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetAt: resetAtSeconds === undefined ? undefined : new Date(resetAtSeconds * 1000).toISOString(),
    resetAfterSeconds: asFiniteNumber(record.reset_after_seconds),
    limitWindowSeconds: asFiniteNumber(record.limit_window_seconds),
  };
}

function normalizeCredits(value: unknown): CodexUsageSnapshot['credits'] {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    hasCredits: typeof record.has_credits === 'boolean' ? record.has_credits : undefined,
    unlimited: typeof record.unlimited === 'boolean' ? record.unlimited : undefined,
    balance: typeof record.balance === 'number' || typeof record.balance === 'string' ? record.balance : undefined,
    approxLocalMessages: normalizeNumberPair(record.approx_local_messages),
    approxCloudMessages: normalizeNumberPair(record.approx_cloud_messages),
  };
}

function normalizeNumberPair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }
  const first = asFiniteNumber(value[0]);
  const second = asFiniteNumber(value[1]);
  return first === undefined || second === undefined ? undefined : [first, second];
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function parseJsonObject(body: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(body);
    return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  } catch {
    return { message: body };
  }
}

function describeCodexUsageHttpError(status: number, body: string): string {
  const parsed = body ? parseJsonObject(body) : {};
  const error = parsed.error;
  const errorRecord = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  const message =
    (typeof error === 'string' ? error : undefined) ||
    (typeof errorRecord?.message === 'string' ? errorRecord.message : undefined) ||
    (typeof parsed.message === 'string' ? parsed.message : undefined) ||
    summarizeHttpErrorBody(body);
  return `Codex usage check failed with status ${status}${message ? `: ${message}` : ''}.`;
}

function readRetryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) {
    return undefined;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) {
    return undefined;
  }
  return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
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
