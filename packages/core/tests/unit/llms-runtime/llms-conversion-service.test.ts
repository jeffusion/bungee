import { describe, expect, test } from 'bun:test';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  ConversionContext,
  LLMProtocolAdapter
} from '@jeffusion/bungee-llms';
import {
  LLMProtocolAdapterRegistry,
  LLMProtocolConversionService
} from '@jeffusion/bungee-llms';

type MockProviderRequest = { payload: string };
type MockProviderResponse = { output: string };
type MockProviderEvent = { kind: string; data: string };

class MockAdapter implements LLMProtocolAdapter<MockProviderRequest, MockProviderResponse, MockProviderEvent> {
  constructor(public readonly provider: 'openai' | 'anthropic' | 'gemini') {}

  toCanonicalRequest(request: MockProviderRequest, _context: ConversionContext): CanonicalRequest {
    return {
      messages: [{ role: 'user', content: request.payload }],
      metadata: { provider: this.provider }
    };
  }

  fromCanonicalRequest(request: CanonicalRequest, _context: ConversionContext): MockProviderRequest {
    const firstMessage = request.messages[0];
    const payload = typeof firstMessage?.content === 'string' ? firstMessage.content : '';
    return { payload: `${this.provider}:${payload}` };
  }

  toCanonicalResponse(response: MockProviderResponse, _context: ConversionContext): CanonicalResponse {
    return {
      message: { role: 'assistant', content: response.output },
      metadata: { provider: this.provider }
    };
  }

  fromCanonicalResponse(response: CanonicalResponse, _context: ConversionContext): MockProviderResponse {
    const output = typeof response.message?.content === 'string' ? response.message.content : '';
    return { output: `${this.provider}:${output}` };
  }

  toCanonicalStreamEvent(event: MockProviderEvent, _context: ConversionContext): CanonicalStreamEvent {
    return {
      type: event.kind,
      payload: event.data
    };
  }

  fromCanonicalStreamEvent(event: CanonicalStreamEvent, _context: ConversionContext): MockProviderEvent {
    return {
      kind: `${this.provider}:${event.type}`,
      data: String(event.payload)
    };
  }
}

describe('LLMProtocolConversionService', () => {
  test('converts request through canonical bridge', () => {
    const registry = new LLMProtocolAdapterRegistry();
    registry.register(new MockAdapter('openai'));
    registry.register(new MockAdapter('anthropic'));

    const service = new LLMProtocolConversionService(registry);
    const converted = service.convertRequest<MockProviderRequest>('openai', 'anthropic', { payload: 'hello' });

    expect(converted).toEqual({ payload: 'anthropic:hello' });
  });

  test('converts response through canonical bridge', () => {
    const service = new LLMProtocolConversionService();
    service.registerAdapter(new MockAdapter('anthropic'));
    service.registerAdapter(new MockAdapter('gemini'));

    const converted = service.convertResponse<MockProviderResponse>('anthropic', 'gemini', { output: 'ok' });

    expect(converted).toEqual({ output: 'gemini:ok' });
  });

  test('converts stream event through canonical bridge', () => {
    const service = new LLMProtocolConversionService();
    service.registerAdapter(new MockAdapter('openai'));
    service.registerAdapter(new MockAdapter('gemini'));

    const converted = service.convertStreamEvent<MockProviderEvent>(
      'openai',
      'gemini',
      { kind: 'delta', data: 'partial' }
    );

    expect(converted).toEqual({ kind: 'gemini:delta', data: 'partial' });
  });

  test('throws when adapter is missing', () => {
    const service = new LLMProtocolConversionService();
    service.registerAdapter(new MockAdapter('openai'));

    expect(() => service.convertRequest('openai', 'anthropic', { payload: 'hello' })).toThrow(
      'No protocol adapter registered for provider: anthropic'
    );
  });
});
