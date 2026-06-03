import { describe, expect, it } from 'vitest';
import { createSourceAdapterRegistry, noopTestAdapter } from '../adapters';

describe('Ecobase source adapter registry', () => {
  it('registers adapter metadata and exposes the no-op adapter', async () => {
    const registry = createSourceAdapterRegistry([noopTestAdapter]);

    expect(registry.list()).toEqual([
      {
        name: 'noop-test',
        title: 'No-op test adapter',
        sourceType: 'noop_test',
        supportedDomains: ['foundation'],
        version: '1.0.0',
      },
    ]);

    const imported = [];
    for await (const item of registry.get('noop-test').import({
      sourceConnectionId: 'source-1',
      sourceIdentifier: 'manual-noop',
      sourceVersion: 'v1',
      idempotencyKey: 'source-1:manual-noop:v1',
      config: {},
    })) {
      imported.push(item);
    }

    expect(imported).toEqual([]);
  });

  it('rejects duplicate adapter names', () => {
    const registry = createSourceAdapterRegistry([noopTestAdapter]);

    expect(() => registry.register(noopTestAdapter)).toThrow(
      'Ecobase source adapter "noop-test" is already registered.',
    );
  });
});
