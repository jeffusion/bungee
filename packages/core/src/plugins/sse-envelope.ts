import type { SSEEnvelope } from '../plugin.types';

/** Explicit protocol output mapping. Original event names are never inferred from payload.type. */
export function protocolSSEOutput(payloads: readonly unknown[], protocol: string, source?: SSEEnvelope): SSEEnvelope[] {
  return payloads.map((json, index) => {
    const envelope: SSEEnvelope = { data: JSON.stringify(json), json };
    if (source?.id !== undefined) envelope.id = source.id;
    if (source?.retry !== undefined) envelope.retry = source.retry;
    if (index === 0 && source?.comments) envelope.comments = [...source.comments];
    // These converters deliberately create Anthropic/Responses protocol event names.
    if ((protocol === 'anthropic' || protocol === 'responses') && json !== null && typeof json === 'object') {
      const type = (json as Record<string, unknown>).type;
      if (typeof type === 'string') envelope.event = type;
    }
    return envelope;
  });
}
