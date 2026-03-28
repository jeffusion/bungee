import type { LLMProtocolAdapter } from './adapter';
import { LLMProtocolAdapterRegistry } from './registry';
import type {
  CanonicalStreamEvent,
  ConversionContext,
  LLMProvider
} from './types';

export class LLMProtocolConversionService {
  constructor(private readonly registry: LLMProtocolAdapterRegistry = new LLMProtocolAdapterRegistry()) {}

  registerAdapter(adapter: LLMProtocolAdapter): void {
    this.registry.register(adapter);
  }

  unregisterAdapter(provider: LLMProvider): void {
    this.registry.unregister(provider);
  }

  convertRequest<T = unknown>(from: LLMProvider, to: LLMProvider, request: unknown, metadata?: Record<string, unknown>): T {
    const source = this.registry.require(from);
    const target = this.registry.require(to);
    const context: ConversionContext = { from, to, metadata };
    const canonical = source.toCanonicalRequest(request, context);
    return target.fromCanonicalRequest(canonical, context) as T;
  }

  convertResponse<T = unknown>(from: LLMProvider, to: LLMProvider, response: unknown, metadata?: Record<string, unknown>): T {
    const source = this.registry.require(from);
    const target = this.registry.require(to);
    const context: ConversionContext = { from, to, metadata };
    const canonical = source.toCanonicalResponse(response, context);
    return target.fromCanonicalResponse(canonical, context) as T;
  }

  convertStreamEvent<T = unknown>(
    from: LLMProvider,
    to: LLMProvider,
    event: unknown,
    metadata?: Record<string, unknown>
  ): T | null {
    const source = this.registry.require(from);
    const target = this.registry.require(to);
    const context: ConversionContext = { from, to, metadata };

    if (!source.toCanonicalStreamEvent || !target.fromCanonicalStreamEvent) {
      return null;
    }

    const canonicalEvent = source.toCanonicalStreamEvent(event, context);
    if (!canonicalEvent) {
      return null;
    }

    return target.fromCanonicalStreamEvent(canonicalEvent, context) as T | null;
  }

  getRegisteredProviders(): string[] {
    return this.registry.listProviders();
  }

  createPassthroughStreamEvent(type: string, payload: unknown): CanonicalStreamEvent {
    return { type, payload };
  }
}
