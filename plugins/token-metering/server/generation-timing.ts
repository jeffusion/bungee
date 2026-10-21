import type { SupportedProvider } from './classifier';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const parameters = (value: unknown): boolean => text(value) || (record(value) && Object.keys(value).length > 0);
const content = (value: unknown): boolean => text(value) || values(value).some(part => record(part) && (text(part.text) || text(part.thinking)));

/** Protocol semantics stay in the metering provider; metadata and usage never start a timer. */
export function generationSignals(provider: SupportedProvider, body: RecordValue, event?: string): { output: boolean; completed: boolean } {
  const type = event || body.type;
  if (provider === 'openai') {
    const choices = values(body.choices).filter(record);
    const output = choices.some(choice => text(choice.text) || (record(choice.delta) && (
      content(choice.delta.content) || text(choice.delta.reasoning_content) || text(choice.delta.reasoning)
      || (record(choice.delta.function_call) && text(choice.delta.function_call.arguments))
      || values(choice.delta.tool_calls).some(tool => record(tool) && record(tool.function) && text(tool.function.arguments))
    ))) || (typeof type === 'string' && [
      'response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta',
      'response.function_call_arguments.delta', 'response.refusal.delta',
    ].includes(type) && text(body.delta));
    return { output, completed: type === 'response.completed' || choices.some(choice => choice.finish_reason !== undefined && choice.finish_reason !== null) };
  }
  if (provider === 'anthropic') {
    const delta = record(body.delta) ? body.delta : undefined;
    const block = type === 'content_block_start' && record(body.content_block) ? body.content_block : undefined;
    return {
      output: (type === 'content_block_delta' && !!delta && (
        (delta.type === 'text_delta' && text(delta.text)) || (delta.type === 'thinking_delta' && text(delta.thinking))
        || (delta.type === 'input_json_delta' && text(delta.partial_json))
      )) || (!!block && (text(block.text) || text(block.thinking) || (block.type === 'tool_use' && parameters(block.input)))),
      completed: type === 'message_stop' || (type === 'message_delta' && !!delta && text(delta.stop_reason)),
    };
  }
  const candidates = values(body.candidates).filter(record);
  return {
    output: candidates.some(candidate => record(candidate.content) && values(candidate.content.parts).some(part => record(part) && (
      text(part.text) || (record(part.functionCall) && parameters(part.functionCall.args))
    ))),
    completed: candidates.some(candidate => text(candidate.finishReason)),
  };
}

/** Only times from the producing Host are accepted; observer execution time is irrelevant. */
export class GenerationTiming {
  private firstOutput?: number;
  private completedAt?: number;
  private terminal = false;
  private missingTime = false;
  private failed = false;
  private branches = new Map<number, { completed: boolean; at?: number }>();
  observe(provider: SupportedProvider, body: RecordValue, at: number | undefined, event?: string): void {
    const type = event || body.type;
    const response = record(body.response) ? body.response : undefined;
    this.failed ||= body.error != null || response?.error != null || type === 'error' || type === 'response.failed' || type === 'response.incomplete' || response?.status === 'failed' || response?.status === 'incomplete';
    if (this.terminal) return;
    const signal = generationSignals(provider, body, event);
    const valid = at !== undefined && Number.isFinite(at);
    if (signal.output && this.firstOutput === undefined) {
      if (valid) this.firstOutput = at;
      else this.missingTime = true;
    }
    const branches = provider === 'openai' ? values(body.choices) : provider === 'gemini' ? values(body.candidates) : [];
    if (branches.length) {
      for (const [position, branch] of branches.entries()) {
        if (!record(branch)) continue;
        const id = Number.isSafeInteger(branch.index) && (branch.index as number) >= 0 ? branch.index as number : position;
        const completed = provider === 'openai' ? text(branch.finish_reason) : text(branch.finishReason);
        if (completed && !valid) this.missingTime = true;
        const previous = this.branches.get(id);
        this.branches.set(id, completed ? { completed: true, at } : previous ?? { completed: false });
      }
    } else if (signal.completed) {
      this.terminal = true;
      if (valid) this.completedAt = at;
      else this.missingTime = true;
    }
  }
  duration(endedAt: number | undefined): number | undefined {
    if (this.failed || this.missingTime || this.firstOutput === undefined) return undefined;
    const completedBranches = this.branches.size > 0 && [...this.branches.values()].every(branch => branch.completed);
    const end = this.terminal ? this.completedAt : completedBranches
      ? Math.max(...[...this.branches.values()].map(branch => branch.at!)) : endedAt;
    if (end === undefined || !Number.isFinite(end)) return undefined;
    const duration = end - this.firstOutput;
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  }
}
