import { maskAccountId } from './codex-oauth';
import { CODEX_SUBSCRIPTION_COLLECTIONS } from '../collections/names';

type Encryptor = {
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
};

type RepositoryModel = {
  get?: (key?: string) => unknown;
  update?: (values: Record<string, unknown>) => Promise<void>;
  destroy?: () => Promise<void>;
  [key: string]: unknown;
};

type Repository = {
  findOne: (options: Record<string, unknown>) => Promise<RepositoryModel | null>;
  create: (options: { values: Record<string, unknown> }) => Promise<RepositoryModel>;
  destroy?: (options: { filter: Record<string, unknown> }) => Promise<void>;
};

export type AppLike = {
  db?: {
    getRepository?: (name: string) => Repository;
  };
  aesEncryptor?: Encryptor;
};

export type StoredCodexCredentials = {
  llmServiceName: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  connectedAt?: string;
  lastVerifiedAt?: string;
};

export type StoredCodexConnectionStatus = {
  llmServiceName: string;
  connected: boolean;
  accountId?: string;
  accountLabel?: string;
  expiresAt?: string;
  connectedAt?: string;
  lastVerifiedAt?: string;
  lastError?: string;
};

export type StoredCodexAuthSession = {
  id: string;
  llmServiceName: string;
  state: string;
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: string;
  redirectUri: string;
  status: 'pending' | 'succeeded' | 'failed';
  errorMessage?: string;
};

function requiredRepository(app: AppLike, name: string): Repository {
  const repository = app.db?.getRepository?.(name);
  if (!repository) {
    throw new Error(`Codex subscription storage is unavailable: repository ${name} is not registered.`);
  }
  return repository;
}

function requiredEncryptor(app: AppLike): Encryptor {
  if (!app.aesEncryptor) {
    throw new Error('Codex subscription storage is unavailable: app.aesEncryptor is not initialized.');
  }
  return app.aesEncryptor;
}

function readValue(model: RepositoryModel | null | undefined, key: string): unknown {
  if (!model) {
    return undefined;
  }
  if (typeof model.get === 'function') {
    return model.get(key);
  }
  return model[key];
}

export async function saveCodexCredentials(app: AppLike, credentials: StoredCodexCredentials): Promise<void> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.connections);
  const encryptor = requiredEncryptor(app);
  const existing = await repository.findOne({ filter: { llmServiceName: credentials.llmServiceName } });
  const values = {
    llmServiceName: credentials.llmServiceName,
    accountId: credentials.accountId,
    accessTokenEncrypted: await encryptor.encrypt(credentials.accessToken),
    refreshTokenEncrypted: await encryptor.encrypt(credentials.refreshToken),
    expiresAt: credentials.expiresAt,
    connectedAt: credentials.connectedAt ?? new Date().toISOString(),
    lastVerifiedAt: credentials.lastVerifiedAt ?? new Date().toISOString(),
    lastError: null,
  };

  if (existing?.update) {
    await existing.update(values);
    return;
  }

  await repository.create({ values });
}

export async function loadCodexCredentials(
  app: AppLike,
  llmServiceName: string,
): Promise<StoredCodexCredentials | null> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.connections);
  const encryptor = requiredEncryptor(app);
  const model = await repository.findOne({ filter: { llmServiceName } });
  if (!model) {
    return null;
  }
  const accessTokenEncrypted = readValue(model, 'accessTokenEncrypted');
  const refreshTokenEncrypted = readValue(model, 'refreshTokenEncrypted');
  if (typeof accessTokenEncrypted !== 'string' || typeof refreshTokenEncrypted !== 'string') {
    throw new Error(`Codex subscription credential record for ${llmServiceName} is incomplete.`);
  }
  const accountId = readValue(model, 'accountId');
  return {
    llmServiceName,
    accountId: typeof accountId === 'string' ? accountId : '',
    accessToken: await encryptor.decrypt(accessTokenEncrypted),
    refreshToken: await encryptor.decrypt(refreshTokenEncrypted),
    expiresAt: asIsoString(readValue(model, 'expiresAt')) ?? '',
    connectedAt: asIsoString(readValue(model, 'connectedAt')),
    lastVerifiedAt: asIsoString(readValue(model, 'lastVerifiedAt')),
  };
}

export async function deleteCodexCredentials(app: AppLike, llmServiceName: string): Promise<void> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.connections);
  const existing = await repository.findOne({ filter: { llmServiceName } });
  if (existing?.destroy) {
    await existing.destroy();
    return;
  }
  if (repository.destroy) {
    await repository.destroy({ filter: { llmServiceName } });
  }
}

export async function recordCodexCredentialError(
  app: AppLike,
  llmServiceName: string,
  lastError: string,
): Promise<void> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.connections);
  const model = await repository.findOne({ filter: { llmServiceName } });
  if (model?.update) {
    await model.update({ lastError, lastVerifiedAt: new Date().toISOString() });
  }
}

export async function getCodexConnectionStatus(
  app: AppLike,
  llmServiceName: string,
): Promise<StoredCodexConnectionStatus> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.connections);
  const model = await repository.findOne({ filter: { llmServiceName } });
  if (!model) {
    return { llmServiceName, connected: false };
  }

  try {
    await loadCodexCredentials(app, llmServiceName);
  } catch (error) {
    return {
      llmServiceName,
      connected: false,
      lastError: error instanceof Error ? error.message : 'Codex subscription credential check failed.',
    };
  }

  const accountId = asString(readValue(model, 'accountId'));
  const lastError = asString(readValue(model, 'lastError'));
  return {
    llmServiceName,
    connected: true,
    accountId,
    accountLabel: maskAccountId(accountId),
    expiresAt: asIsoString(readValue(model, 'expiresAt')),
    connectedAt: asIsoString(readValue(model, 'connectedAt')),
    lastVerifiedAt: asIsoString(readValue(model, 'lastVerifiedAt')),
    lastError,
  };
}

export async function createCodexAuthSession(app: AppLike, session: StoredCodexAuthSession): Promise<void> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.authSessions);
  const encryptor = requiredEncryptor(app);
  await repository.create({
    values: {
      id: session.id,
      llmServiceName: session.llmServiceName,
      state: session.state,
      verifierEncrypted: await encryptor.encrypt(session.deviceAuthId),
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      intervalSeconds: session.intervalSeconds,
      expiresAt: session.expiresAt,
      redirectUri: session.redirectUri,
      status: session.status,
      errorMessage: session.errorMessage ?? null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    },
  });
}

export async function loadCodexAuthSessionById(app: AppLike, id: string): Promise<StoredCodexAuthSession | null> {
  return loadCodexAuthSession(app, { id });
}

export async function loadCodexAuthSessionByState(app: AppLike, state: string): Promise<StoredCodexAuthSession | null> {
  return loadCodexAuthSession(app, { state });
}

export async function loadLatestCodexAuthSessionByService(
  app: AppLike,
  llmServiceName: string,
): Promise<StoredCodexAuthSession | null> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.authSessions);
  const encryptor = requiredEncryptor(app);
  const model = await repository.findOne({ filter: { llmServiceName }, sort: ['-createdAt'] });
  try {
    return await readCodexAuthSessionModel(encryptor, model);
  } catch (error) {
    if (!isDecryptFailure(error) || !model?.update) {
      throw error;
    }
    await model.update({
      status: 'failed',
      errorMessage: 'Stored Codex device-code session could not be read. Start a new connection.',
      completedAt: new Date().toISOString(),
    });
    return null;
  }
}

async function loadCodexAuthSession(
  app: AppLike,
  filter: Record<string, unknown>,
): Promise<StoredCodexAuthSession | null> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.authSessions);
  const encryptor = requiredEncryptor(app);
  const model = await repository.findOne({ filter });
  return readCodexAuthSessionModel(encryptor, model);
}

async function readCodexAuthSessionModel(
  encryptor: Encryptor,
  model: RepositoryModel | null,
): Promise<StoredCodexAuthSession | null> {
  if (!model) {
    return null;
  }
  const verifierEncrypted = readValue(model, 'verifierEncrypted');
  if (typeof verifierEncrypted !== 'string') {
    throw new Error('Codex subscription auth session is missing its verifier.');
  }
  return {
    id: String(readValue(model, 'id') ?? ''),
    llmServiceName: String(readValue(model, 'llmServiceName') ?? ''),
    state: String(readValue(model, 'state') ?? ''),
    deviceAuthId: await encryptor.decrypt(verifierEncrypted),
    userCode: String(readValue(model, 'userCode') ?? ''),
    verificationUri: String(readValue(model, 'verificationUri') ?? ''),
    intervalSeconds: normalizeIntervalSeconds(readValue(model, 'intervalSeconds')),
    expiresAt: asIsoString(readValue(model, 'expiresAt')) ?? '',
    redirectUri: String(readValue(model, 'redirectUri') ?? ''),
    status: normalizeSessionStatus(readValue(model, 'status')),
    errorMessage: asString(readValue(model, 'errorMessage')),
  };
}

export async function completeCodexAuthSession(
  app: AppLike,
  id: string,
  update: { status: 'succeeded' | 'failed'; errorMessage?: string },
): Promise<void> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.authSessions);
  const model = await repository.findOne({ filter: { id } });
  if (!model?.update) {
    throw new Error(`Codex subscription auth session ${id} was not found.`);
  }
  await model.update({
    status: update.status,
    errorMessage: update.errorMessage ?? null,
    completedAt: new Date().toISOString(),
  });
}

export async function updateCodexAuthSessionPolling(
  app: AppLike,
  id: string,
  update: { errorMessage?: string; intervalSeconds?: number },
): Promise<void> {
  const repository = requiredRepository(app, CODEX_SUBSCRIPTION_COLLECTIONS.authSessions);
  const model = await repository.findOne({ filter: { id } });
  if (!model?.update) {
    throw new Error(`Codex subscription auth session ${id} was not found.`);
  }
  await model.update({
    status: 'pending',
    errorMessage: update.errorMessage ?? null,
    intervalSeconds: update.intervalSeconds,
    completedAt: null,
  });
}

function isDecryptFailure(error: unknown): boolean {
  return error instanceof Error && /bad decrypt|decrypt/i.test(error.message);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asIsoString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return undefined;
}

function normalizeSessionStatus(value: unknown): 'pending' | 'succeeded' | 'failed' {
  if (value === 'succeeded' || value === 'failed') {
    return value;
  }
  return 'pending';
}

function normalizeIntervalSeconds(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}
