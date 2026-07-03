import type { AdapterStreamItem, SourceAdapter, SourceAdapterImportInput } from './types';

const emptyAdapterStream: AsyncIterable<AdapterStreamItem> = {
  [Symbol.asyncIterator](): AsyncIterator<AdapterStreamItem> {
    return {
      async next(): Promise<IteratorResult<AdapterStreamItem>> {
        return { done: true, value: undefined };
      },
    };
  },
};

export const noopTestAdapter: SourceAdapter = {
  metadata: {
    name: 'noop-test',
    title: 'No-op test adapter',
    sourceType: 'noop_test',
    supportedDomains: ['foundation'],
    version: '1.0.0',
  },

  import(_input: SourceAdapterImportInput): AsyncIterable<AdapterStreamItem> {
    return emptyAdapterStream;
  },
};
