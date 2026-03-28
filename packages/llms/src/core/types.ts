export type LLMProvider = 'openai' | 'anthropic' | 'gemini' | (string & {});

export type CanonicalRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface CanonicalToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CanonicalMessage {
  role: CanonicalRole;
  content: unknown;
  toolCalls?: CanonicalToolCall[];
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalRequest {
  model?: string;
  messages: CanonicalMessage[];
  tools?: CanonicalToolDefinition[];
  toolChoice?: unknown;
  metadata?: Record<string, unknown>;
}

export interface CanonicalResponse {
  message?: CanonicalMessage;
  messages?: CanonicalMessage[];
  metadata?: Record<string, unknown>;
}

export interface CanonicalStreamEvent {
  type: string;
  payload: unknown;
}

export interface ConversionContext {
  from: LLMProvider;
  to: LLMProvider;
  metadata?: Record<string, unknown>;
}
