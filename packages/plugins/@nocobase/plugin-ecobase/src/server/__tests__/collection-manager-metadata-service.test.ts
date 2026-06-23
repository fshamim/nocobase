import { describe, expect, it } from 'vitest';
import { ensureEcobaseCollectionManagerMetadata } from '../services/collection-manager-metadata-service';

describe('ensureEcobaseCollectionManagerMetadata', () => {
  it('skips metadata sync when collection-manager repositories are not installed', async () => {
    const db = {
      getRepository(name: string) {
        throw new Error(`Repository ${name} is not registered.`);
      },
    };

    await expect(ensureEcobaseCollectionManagerMetadata(db as never)).resolves.toBeUndefined();
  });
});
