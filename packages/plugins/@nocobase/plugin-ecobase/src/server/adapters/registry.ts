import type { SourceAdapter, SourceAdapterMetadata } from './types';

export class SourceAdapterRegistry {
  private adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter) {
    const name = adapter.metadata.name;
    if (!name) {
      throw new Error('Ecobase source adapter registration failed: metadata.name is required.');
    }
    if (this.adapters.has(name)) {
      throw new Error(`Ecobase source adapter "${name}" is already registered.`);
    }
    this.adapters.set(name, adapter);
  }

  get(name: string) {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Ecobase source adapter "${name}" is not registered.`);
    }
    return adapter;
  }

  list(): SourceAdapterMetadata[] {
    return Array.from(this.adapters.values()).map((adapter) => adapter.metadata);
  }
}

export function createSourceAdapterRegistry(adapters: SourceAdapter[] = []) {
  const registry = new SourceAdapterRegistry();
  adapters.forEach((adapter) => registry.register(adapter));
  return registry;
}
