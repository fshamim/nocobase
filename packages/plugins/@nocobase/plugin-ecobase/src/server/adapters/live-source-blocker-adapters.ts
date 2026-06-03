import type { AdapterStreamItem, SourceAdapter, SourceAdapterImportInput } from './types';

function hasCredential(config: Record<string, unknown>, secretRef: string | undefined, keys: string[]) {
  if (secretRef) {
    return true;
  }
  return keys.some((key) => typeof config[key] === 'string' && String(config[key]).trim().length > 0);
}

function blockerRecord(
  input: SourceAdapterImportInput,
  adapterName: string,
  sourceType: string,
  blockerCode: string,
  message: string,
) {
  const checkedAt = new Date().toISOString();
  return {
    kind: 'source_access_audit',
    data: {
      naturalKey: [input.sourceConnectionId, 'source_access_audit', adapterName, input.sourceVersion].join(':'),
      sourceConnectionId: input.sourceConnectionId,
      sourceType,
      adapterName,
      status: 'blocked',
      blockerCode,
      message,
      checkedAt,
      payload: { sourceIdentifier: input.sourceIdentifier, sourceVersion: input.sourceVersion },
    },
  };
}

async function* sellerboardApiImport(input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem> {
  if (!hasCredential(input.config, input.secretRef, ['apiToken', 'accessToken'])) {
    yield {
      type: 'record',
      rowNumber: 1,
      sourceKey: 'sellerboard-api-access',
      payload: { status: 'blocked', blockerCode: 'sellerboard_credentials_missing' },
      record: blockerRecord(
        input,
        'sellerboard-api',
        'sellerboard',
        'sellerboard_credentials_missing',
        'Sellerboard API credentials are not configured; CSV parity remains the accepted MVP source and live API follow-up is tracked for Issue 016.',
      ),
    };
  }
}

async function* amazonSpApiImport(input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem> {
  if (!hasCredential(input.config, input.secretRef, ['refreshToken', 'lwaClientId', 'roleArn'])) {
    yield {
      type: 'record',
      rowNumber: 1,
      sourceKey: 'amazon-sp-api-access',
      payload: { status: 'blocked', blockerCode: 'amazon_sp_api_access_missing' },
      record: blockerRecord(
        input,
        'amazon-sp-api-access-check',
        'amazon_sp_api',
        'amazon_sp_api_access_missing',
        'Amazon SP-API access is not configured or approved; Sellerboard remains the accepted MVP profit/operations source until access is ready.',
      ),
    };
  }
}

export const sellerboardApiAdapter: SourceAdapter = {
  metadata: {
    name: 'sellerboard-api',
    title: 'Sellerboard API',
    sourceType: 'sellerboard',
    supportedDomains: ['amazon_operations', 'foundation'],
    version: '1.0.0',
  },
  import: sellerboardApiImport,
};

export const amazonSpApiAccessCheckAdapter: SourceAdapter = {
  metadata: {
    name: 'amazon-sp-api-access-check',
    title: 'Amazon SP-API access check',
    sourceType: 'amazon_sp_api',
    supportedDomains: ['amazon_operations', 'foundation'],
    version: '1.0.0',
  },
  import: amazonSpApiImport,
};
