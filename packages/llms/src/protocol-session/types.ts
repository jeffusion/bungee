import type { ResponsesCodecCapabilities, ResponsesConversionDiagnostic, ResponsesToolNames } from '../responses-codec';
export const LLM_PROTOCOLS = ['responses', 'chat_completions', 'anthropic_messages', 'gemini_generate_content'] as const;
export type LLMProtocol = typeof LLM_PROTOCOLS[number];
export type ProtocolJsonObject = Record<string, unknown>;
/** Every mapping is supplied by the capability owner, never inferred from a reasoning flag. */
export interface ProtocolReasoningPolicy {
  effortMap?: Readonly<Record<string, string>>;
  /** Verified target effort for source budget/mode policies that have no effort label. */
  targetEffort?: string;
  anthropicThinkingBudget?: number;
  anthropicThinkingMode?: 'adaptive' | 'enabled' | 'disabled';
  geminiThinkingBudget?: number;
  geminiThinkingLevel?: string;
}
export interface ProtocolSessionCapabilities extends ResponsesCodecCapabilities {
  anthropicStructuredOutput?: boolean;
  anthropicStrictTools?: boolean;
  anthropicEffort?: boolean;
  geminiJsonSchema?: boolean;
}
export interface ProtocolSessionContext {
  sourceProtocol: LLMProtocol;
  targetProtocol: LLMProtocol;
  /** Target model; caller owns routing and source URL validation. */
  model: string;
  /** Transport-derived mode for protocols such as Gemini whose stream flag is in the URL. */
  streaming?: boolean;
  responseModel?: string;
  capabilities?: ProtocolSessionCapabilities;
  reasoningPolicy?: ProtocolReasoningPolicy;
}
export interface ProtocolRequestConversion {
  body: ProtocolJsonObject;
  canonicalHistory: ProtocolJsonObject[];
  diagnostics: ResponsesConversionDiagnostic[];
  toolNames: ResponsesToolNames;
  streaming: boolean;
}
/** Requests flow source→target; responses and JSON stream events flow target→source.
 * Transport framing, [DONE], HTTP errors, readers and cancellation are caller-owned.
 */
export interface ProtocolSession {
  convertRequest(raw: unknown): ProtocolRequestConversion;
  convertResponse(raw: unknown): ProtocolJsonObject;
  push(event: unknown): ProtocolJsonObject[];
  finish(): ProtocolJsonObject[];
  dispose(): void;
}
