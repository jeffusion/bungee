import type { LLMProvider } from '../core/types';

export interface ProviderCapabilities {
  supportsChatCompletions?: boolean;
  supportsResponsesApi?: boolean;
  supportsToolCalls?: boolean;
  supportsReasoning?: boolean;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  [key: string]: unknown;
}

export interface ProviderDescriptor {
  provider: LLMProvider;
  displayName?: string;
  aliases?: string[];
  capabilities?: ProviderCapabilities;
  metadata?: Record<string, unknown>;
}

function normalizeProvider(provider: LLMProvider | string): string {
  return String(provider).trim().toLowerCase();
}

export class LLMProviderCatalog {
  private readonly descriptors = new Map<string, ProviderDescriptor>();
  private readonly aliasToProvider = new Map<string, string>();

  register(descriptor: ProviderDescriptor): void {
    const normalizedProvider = normalizeProvider(descriptor.provider);
    this.descriptors.set(normalizedProvider, descriptor);

    const aliases = Array.isArray(descriptor.aliases) ? descriptor.aliases : [];
    for (const alias of aliases) {
      const normalizedAlias = normalizeProvider(alias);
      if (normalizedAlias) {
        this.aliasToProvider.set(normalizedAlias, normalizedProvider);
      }
    }
  }

  unregister(provider: LLMProvider): void {
    const normalizedProvider = normalizeProvider(provider);
    this.descriptors.delete(normalizedProvider);

    for (const [alias, mappedProvider] of this.aliasToProvider.entries()) {
      if (mappedProvider === normalizedProvider) {
        this.aliasToProvider.delete(alias);
      }
    }
  }

  get(provider: LLMProvider | string): ProviderDescriptor | undefined {
    const normalizedInput = normalizeProvider(provider);
    const mappedProvider = this.aliasToProvider.get(normalizedInput) ?? normalizedInput;
    return this.descriptors.get(mappedProvider);
  }

  has(provider: LLMProvider | string): boolean {
    return this.get(provider) !== undefined;
  }

  list(): ProviderDescriptor[] {
    return [...this.descriptors.values()];
  }
}
