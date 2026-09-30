import { createParser } from 'eventsource-parser';
import type { RawResponseCompletion } from '../../plugin-control/contracts';

/** Observes complete SSE frames at the final client-body boundary, after conversion. */
export class SSETerminalOutcome {
  private readonly decoder = new TextDecoder();
  private bufferedChars = 0;
  private disabled = false;
  private responsesProtocol = false;
  private terminal?: RawResponseCompletion;
  private readonly parser = createParser({
    onEvent: (event) => {
      this.bufferedChars = 0;
      if (this.terminal?.status === 'failed') return;
      if (event.data.trim() === '[DONE]') {
        this.terminal ??= this.responsesProtocol
          ? { status: 'incomplete', code: 'missing_response_terminal' }
          : { status: 'completed' };
        return;
      }
      let body: Record<string, any>;
      try {
        body = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      const type = body.type ?? event.event;
      if (typeof type === 'string' && type.startsWith('response.')) this.responsesProtocol = true;
      if (type === 'error' || type === 'response.failed' || body.error || body.response?.status === 'failed') {
        this.terminal = { status: 'failed', code: 'upstream_protocol_error' };
      } else if (type === 'response.incomplete' || body.response?.status === 'incomplete'
        || (Array.isArray(body.choices) && body.choices.some((choice: any) =>
          ['max_tokens', 'max_output_tokens', 'content_filter'].includes(choice?.native_finish_reason)))) {
        // The OAuth Responses-to-Chat conversion preserves incompleteness here,
        // even though its outbound stream still ends with a normal [DONE] frame.
        this.terminal = { status: 'incomplete', code: 'incomplete' };
      } else if (type === 'response.completed' && body.response
        && typeof body.response === 'object' && !Array.isArray(body.response)
        && (body.response.status === undefined || body.response.status === 'completed')) {
        this.terminal ??= { status: 'completed' };
      } else if (type === 'message_stop' && body.type === 'message_stop') {
        this.terminal ??= { status: 'completed' };
      }
    },
  });

  push(chunk: Uint8Array): void {
    if (this.disabled) return;
    const text = this.decoder.decode(chunk, { stream: true });
    // Bound observation memory without imposing a limit on the proxied response.
    for (let offset = 0; offset < text.length; offset += 16_384) {
      const segment = text.slice(offset, offset + 16_384);
      this.bufferedChars += segment.length;
      this.parser.feed(segment);
      if (this.bufferedChars > 1_048_576) {
        this.parser.reset();
        this.disabled = true;
        if (this.terminal?.status === 'completed') this.terminal = undefined;
        break;
      }
    }
  }

  /** Protocol errors win; a complete terminal frame only replaces transport cancellation. */
  resolve(outcome: RawResponseCompletion): RawResponseCompletion {
    if (outcome.status === 'failed' || outcome.status === 'incomplete') return outcome;
    if (this.terminal?.status === 'failed' || this.terminal?.status === 'incomplete') return this.terminal;
    return outcome.status === 'cancelled' ? this.terminal ?? outcome : outcome;
  }
}
