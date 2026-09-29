import type { LLMProvider } from '../core/types';

export const SUPPORTED_TOKEN_ACCOUNTING_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;

export type SupportedTokenAccountingProvider = typeof SUPPORTED_TOKEN_ACCOUNTING_PROVIDERS[number];

export const TOKEN_ACCOUNTING_AUTHORITIES = [
  'official',
  'local',
  'heuristic',
  'partial',
  'none'
] as const;

export const TOKEN_ACCOUNTING_OUTCOMES = ['completed', 'aborted', 'failed'] as const;

export type TokenAccountingAuthority = typeof TOKEN_ACCOUNTING_AUTHORITIES[number];
export type TokenAccountingOutcome = typeof TOKEN_ACCOUNTING_OUTCOMES[number];

export interface CanonicalTokenAccountingEventV2 {
  requestId: string;
  attemptId: string;
  routeId: string;
  upstreamId: string;
  provider: LLMProvider;
  model: string;
  streaming: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputAuthority: TokenAccountingAuthority;
  outputAuthority: TokenAccountingAuthority;
  final: boolean;
  outcome: TokenAccountingOutcome;
  countedAt: string;
}

export interface TokenAccountingSessionInput {
  provider: LLMProvider;
  model?: string;
  routeId: string;
  upstreamId: string;
  requestId: string;
  attemptId: string;
  streaming: boolean;
}

export interface TokenAccountingRequestInput {
  body: Record<string, unknown>;
}

export interface TokenAccountingResponseInput {
  body: Record<string, unknown>;
}

export interface TokenAccountingStreamChunkInput {
  chunk: Record<string, unknown>;
}

export interface TokenAccountingSession {
  consumeRequest(input: TokenAccountingRequestInput): void;
  consumeResponse(input: TokenAccountingResponseInput): CanonicalTokenAccountingEventV2;
  consumeStreamChunk(input: TokenAccountingStreamChunkInput): CanonicalTokenAccountingEventV2 | null;
  finalizeCompletedStream(): CanonicalTokenAccountingEventV2;
  finalizeAbortedStream(): CanonicalTokenAccountingEventV2;
}

export interface DedicatedCountEndpointCapability {
  supported: boolean;
  mode: 'input_estimate_only';
  livePathAuthority: false;
  defaultEnabled?: false;
  endpoint?: string;
}

export interface ProviderTokenAccountingCapabilities {
  provider: SupportedTokenAccountingProvider;
  supportsOfficialResponseUsage: boolean;
  supportsStreamingResponseUsage: boolean;
  supportsDedicatedCountEndpoint: boolean;
  supportsLocalTokenizer: boolean;
  supportsHeuristicFallback: boolean;
  dedicatedCountEndpoint?: DedicatedCountEndpointCapability;
  countTokens?: {
    supported: boolean;
    mode: 'input_estimate_only';
    livePathAuthority: false;
  };
}

export type ProviderTokenAccountingCapabilityMatrix = Record<
  SupportedTokenAccountingProvider,
  ProviderTokenAccountingCapabilities
>;

export interface TokenAccountingSessionState {
  provider: LLMProvider;
  routeId: string;
  upstreamId: string;
  requestId: string;
  attemptId: string;
  streaming: boolean;
  model?: string;
  requestBody?: Record<string, unknown>;
  estimatedInputTokens?: number;
  estimatedInputAuthority?: TokenAccountingAuthority;
  outputTokens?: number;
  outputAuthority?: TokenAccountingAuthority;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  protocolTerminalSeen?: boolean;
  finalReceived: boolean;
}

export interface ProviderTokenAccountingAdapter {
  readonly provider: LLMProvider;
  readonly capabilities: ProviderTokenAccountingCapabilities;
  consumeRequest(state: TokenAccountingSessionState, body: Record<string, unknown>): void;
  consumeResponse(state: TokenAccountingSessionState, body: Record<string, unknown>): CanonicalTokenAccountingEventV2;
  consumeStreamChunk(state: TokenAccountingSessionState, chunk: Record<string, unknown>): CanonicalTokenAccountingEventV2 | null;
  finalizeCompletedStream(state: TokenAccountingSessionState): CanonicalTokenAccountingEventV2;
  finalizeAbortedStream(state: TokenAccountingSessionState): CanonicalTokenAccountingEventV2;
}
