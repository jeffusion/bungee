import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  ConversionContext,
  LLMProvider
} from './types';

export interface LLMProtocolAdapter<
  ProviderRequest = unknown,
  ProviderResponse = unknown,
  ProviderStreamEvent = unknown
> {
  readonly provider: LLMProvider;
  toCanonicalRequest(request: ProviderRequest, context: ConversionContext): CanonicalRequest;
  fromCanonicalRequest(request: CanonicalRequest, context: ConversionContext): ProviderRequest;
  toCanonicalResponse(response: ProviderResponse, context: ConversionContext): CanonicalResponse;
  fromCanonicalResponse(response: CanonicalResponse, context: ConversionContext): ProviderResponse;
  toCanonicalStreamEvent?(event: ProviderStreamEvent, context: ConversionContext): CanonicalStreamEvent | null;
  fromCanonicalStreamEvent?(event: CanonicalStreamEvent, context: ConversionContext): ProviderStreamEvent | null;
}
