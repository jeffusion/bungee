import type { WebSocketMessageView } from '../gateway/websocket-contracts';

/** One immutable view per complete message; parsing is shared and demand driven. */
export function createWebSocketMessageView(message: string | Uint8Array): WebSocketMessageView {
  const kind = typeof message === 'string' ? 'text' : 'binary';
  let parsed = false;
  let value: unknown;
  return Object.freeze({
    kind,
    byteLength: typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength,
    mayContainJsonString(...prefixes: readonly string[]): boolean {
      return typeof message !== 'string' || prefixes.some(prefix => message.includes('"' + prefix)) || message.includes('\\');
    },
    json(options?: { readonly binary?: boolean }): unknown {
      if (typeof message !== 'string' && !options?.binary) return undefined;
      if (parsed) return value;
      parsed = true;
      try {
        value = JSON.parse(typeof message === 'string' ? message : new TextDecoder('utf-8', { fatal: true }).decode(message));
        // Iterative traversal also handles deeply nested (valid) JSON without
        // recursive freeze overflowing the JavaScript call stack.
        const pending: unknown[] = [value];
        while (pending.length > 0) {
          const item = pending.pop();
          if (item === null || typeof item !== 'object') continue;
          for (const child of Object.values(item)) pending.push(child);
          Object.freeze(item);
        }
      } catch { value = undefined; }
      return value;
    },
  });
}
