import { atParam, fail, record, string, type JsonRecord, type ResponsesCodecCapabilities,
  type ResponsesConversionDiagnostic, type ResponsesProtocol } from './common';

function fields(value: JsonRecord, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) {
    // Do not echo a caller-controlled key or its value in the message.
    fail('unsupported_request', 'Unrecognized request option', `${path}.${key}`);
  }
}

/** Known preferences may be omitted; output constraints are handled by the request renderer. */
export function applyResponsesPreferences(body: JsonRecord, result: JsonRecord, protocol: ResponsesProtocol,
  capabilities: ResponsesCodecCapabilities, maxTokens: unknown, diagnostics: ResponsesConversionDiagnostic[]): void {
  const note = (param: string, action: 'mapped' | 'omitted', reason: string) => diagnostics.push({param, action, reason});
  if (body.stream_options !== undefined) atParam('stream_options', () => {
    const options = record(body.stream_options, 'stream_options');
    fields(options, ['include_usage', 'reasoning_summary_delivery'], 'stream_options');
    if (options.include_usage !== undefined) {
      if (typeof options.include_usage !== 'boolean') fail('invalid_payload', 'Usage preference must be boolean', 'stream_options.include_usage');
      note('stream_options.include_usage', protocol === 'chat_completions' && body.stream === true ? 'mapped' : 'omitted',
        protocol === 'chat_completions' && body.stream === true ? 'stream_usage_required' : 'target_usage_events');
    }
    if (options.reasoning_summary_delivery !== undefined) {
      if (options.reasoning_summary_delivery !== 'sequential_cutoff') fail('unsupported_request', 'Unsupported summary delivery preference', 'stream_options.reasoning_summary_delivery');
      note('stream_options.reasoning_summary_delivery', 'omitted', 'source_summary_delivery_not_applicable');
    }
  });
  if (body.access_programs !== undefined) atParam('access_programs', () => {
    const programs = record(body.access_programs, 'access_programs');
    fields(programs, ['cyber'], 'access_programs');
    if (programs.cyber !== undefined && programs.cyber !== 'standard') {
      if (programs.cyber === 'daybreak_blue' || programs.cyber === 'daybreak_red') {
        fail('unsupported_access_program', 'Selected access program cannot be represented by the target protocol', 'access_programs.cyber');
      }
      fail('invalid_payload', 'Invalid access program', 'access_programs.cyber');
    }
    note('access_programs', 'omitted', 'target_uses_own_access_policy');
  });
  if (body.reasoning !== undefined) atParam('reasoning', () => {
    const reasoning = record(body.reasoning, 'reasoning');
    fields(reasoning, ['effort', 'summary', 'context'], 'reasoning');
    if (reasoning.summary !== undefined) {
      if (typeof reasoning.summary !== 'string' || !['none', 'auto', 'concise', 'detailed'].includes(reasoning.summary)) fail('invalid_payload', 'Invalid reasoning summary preference', 'reasoning.summary');
      note('reasoning.summary', 'omitted', 'target_summary_not_guaranteed');
    }
    if (reasoning.context !== undefined) {
      if (reasoning.context !== 'all_turns') fail('unsupported_reasoning', 'Unsupported reasoning context preference', 'reasoning.context');
      note('reasoning.context', 'omitted', 'source_reasoning_context_not_applicable');
    }
    if (reasoning.effort !== undefined) atParam('reasoning.effort', () => {
      const effort = string(reasoning.effort, 'reasoning effort', true);
      if (protocol === 'chat_completions' && capabilities.reasoningEffort) {
        result.reasoning_effort = effort;
        note('reasoning.effort', 'mapped', 'target_reasoning_effort');
      } else if (protocol === 'anthropic_messages' && capabilities.anthropicThinkingBudget !== undefined && effort !== 'none') {
        const budget = capabilities.anthropicThinkingBudget;
        if (!Number.isSafeInteger(budget) || budget < 1024 || typeof maxTokens !== 'number' || budget >= maxTokens) {
          fail('unsupported_reasoning', 'Anthropic thinking requires an explicit budget below max_output_tokens');
        }
        result.thinking = {type: 'enabled', budget_tokens: budget};
        note('reasoning.effort', 'mapped', 'explicit_target_thinking_budget');
      } else note('reasoning.effort', 'omitted', 'target_reasoning_effort_unavailable');
    });
  });
  if (body.text !== undefined) atParam('text', () => {
    const text = record(body.text, 'text');
    fields(text, ['verbosity', 'format'], 'text');
    if (text.verbosity !== undefined) {
      if (typeof text.verbosity !== 'string' || !['low', 'medium', 'high'].includes(text.verbosity)) fail('invalid_payload', 'Invalid text verbosity preference', 'text.verbosity');
      note('text.verbosity', 'omitted', 'target_verbosity_not_available');
    }
  });
}
