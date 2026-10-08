import type { WebSocketMessageView } from '../gateway/websocket-contracts';

/** One immutable view per complete message; parsing is shared and demand driven. */
export function createWebSocketMessageView(message: string | Uint8Array): WebSocketMessageView {
  const kind = typeof message === 'string' ? 'text' : 'binary';
  let parsed = false;
  let value: unknown;
  return Object.freeze({
    kind,
    byteLength: typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength,
    json(): unknown {
      if (parsed) return value;
      parsed = true;
      if (typeof message !== 'string') return undefined;
      try {
        value = JSON.parse(message);
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
