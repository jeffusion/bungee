import type { LLMProtocolAdapter } from './adapter';
import type { LLMProvider } from './types';

function normalizeProvider(provider: LLMProvider): string {
  return String(provider).trim().toLowerCase();
}

export class LLMProtocolAdapterRegistry {
  private readonly adapters = new Map<string, LLMProtocolAdapter>();

  register(adapter: LLMProtocolAdapter): void {
    this.adapters.set(normalizeProvider(adapter.provider), adapter);
  }

  unregister(provider: LLMProvider): void {
    this.adapters.delete(normalizeProvider(provider));
  }

  get(provider: LLMProvider): LLMProtocolAdapter | undefined {
    return this.adapters.get(normalizeProvider(provider));
  }

  require(provider: LLMProvider): LLMProtocolAdapter {
    const adapter = this.get(provider);
    if (!adapter) {
      throw new Error(`No protocol adapter registered for provider: ${provider}`);
    }

    return adapter;
  }

  listProviders(): string[] {
    return [...this.adapters.keys()];
  }
}
