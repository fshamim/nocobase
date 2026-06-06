export type EcobaseSourceType =
  | 'sellerboard'
  | 'amazon_sp_api'
  | 'seller_central_file'
  | 'google_sheets'
  | 'clickup'
  | 'noop_test';

export interface SourceAdapterMetadata {
  name: string;
  title: string;
  sourceType: EcobaseSourceType;
  supportedDomains: string[];
  version: string;
}

export interface SourceAdapterImportInput {
  sourceConnectionId: string;
  sourceIdentifier: string;
  sourceVersion: string;
  idempotencyKey: string;
  config: Record<string, unknown>;
  secretRef?: string;
}

export interface NormalizedRecord {
  kind: string;
  data: Record<string, unknown>;
}

export type AdapterRowIssueSeverity = 'warning' | 'error';

export interface AdapterRowIssue {
  rowNumber: number;
  severity: AdapterRowIssueSeverity;
  code: string;
  message: string;
  sourceKey?: string;
  payload?: Record<string, unknown>;
}

export type AdapterStreamItem =
  | {
      type: 'record';
      rowNumber: number;
      sourceKey?: string;
      payload: Record<string, unknown>;
      record: NormalizedRecord | NormalizedRecord[];
    }
  | { type: 'rowIssue'; issue: AdapterRowIssue }
  | { type: 'status'; status: string; message: string; payload?: Record<string, unknown> };

export interface SourceAdapter {
  metadata: SourceAdapterMetadata;
  import(input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem>;
}
