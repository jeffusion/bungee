import type { LLMProtocolAdapter } from '../core/adapter';
import { LLMProtocolAdapterRegistry } from '../core/registry';
import { LLMProtocolConversionService } from '../core/conversion-service';
import type { LLMProvider } from '../core/types';
import { LLMProviderCatalog, type ProviderDescriptor } from '../providers/provider-catalog';

export interface LLMSRuntimeOptions {
  adapterRegistry?: LLMProtocolAdapterRegistry;
  conversionService?: LLMProtocolConversionService;
  providerCatalog?: LLMProviderCatalog;
}

export interface RuntimeAdapterRegistration {
  adapter: LLMProtocolAdapter;
  descriptor?: ProviderDescriptor;
}

export class LLMSRuntime {
  private readonly adapterRegistry: LLMProtocolAdapterRegistry;
  private readonly conversionService: LLMProtocolConversionService;
  private readonly providerCatalog: LLMProviderCatalog;

  constructor(options: LLMSRuntimeOptions = {}) {
    this.adapterRegistry = options.adapterRegistry ?? new LLMProtocolAdapterRegistry();
    this.conversionService = options.conversionService ?? new LLMProtocolConversionService(this.adapterRegistry);
    this.providerCatalog = options.providerCatalog ?? new LLMProviderCatalog();
  }

  registerAdapter(adapter: LLMProtocolAdapter, descriptor?: ProviderDescriptor): void {
    this.adapterRegistry.register(adapter);

    const providerDescriptor: ProviderDescriptor = descriptor ?? {
      provider: adapter.provider,
      displayName: String(adapter.provider)
    };
    this.providerCatalog.register(providerDescriptor);
  }

  registerAdapters(registrations: RuntimeAdapterRegistration[]): void {
    for (const registration of registrations) {
      this.registerAdapter(registration.adapter, registration.descriptor);
    }
  }

  unregisterProvider(provider: LLMProvider): void {
    this.adapterRegistry.unregister(provider);
    this.providerCatalog.unregister(provider);
  }

  convertRequest<T = unknown>(
    from: LLMProvider,
    to: LLMProvider,
    request: unknown,
    metadata?: Record<string, unknown>
  ): T {
    return this.conversionService.convertRequest<T>(from, to, request, metadata);
  }

  convertResponse<T = unknown>(
    from: LLMProvider,
    to: LLMProvider,
    response: unknown,
    metadata?: Record<string, unknown>
  ): T {
    return this.conversionService.convertResponse<T>(from, to, response, metadata);
  }

  convertStreamEvent<T = unknown>(
    from: LLMProvider,
    to: LLMProvider,
    event: unknown,
    metadata?: Record<string, unknown>
  ): T | null {
    return this.conversionService.convertStreamEvent<T>(from, to, event, metadata);
  }

  getProviderCatalog(): LLMProviderCatalog {
    return this.providerCatalog;
  }

  getAdapterRegistry(): LLMProtocolAdapterRegistry {
    return this.adapterRegistry;
  }

  getConversionService(): LLMProtocolConversionService {
    return this.conversionService;
  }

  listProviders(): ProviderDescriptor[] {
    return this.providerCatalog.list();
  }
}
