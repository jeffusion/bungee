const MAX_CONTROL_BODY_BYTES = 1_048_576;

export type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413; readonly error: 'invalid_json' | 'payload_too_large' | 'duplicate_property' };

function findDuplicateProperty(text: string): string | null {
  const stack: Array<{ readonly type: 'object' | 'array'; keys?: Set<string> }> = [];
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      let cursor = index;
      while (cursor < length && (text[cursor] === ' ' || text[cursor] === '\t' || text[cursor] === '\n' || text[cursor] === '\r')) {
        cursor += 1;
      }
      const top = stack[stack.length - 1];
      if (text[cursor] === ':' && top !== undefined && top.type === 'object' && top.keys !== undefined) {
        const key: unknown = JSON.parse(text.slice(start, index));
        if (typeof key === 'string') {
          if (top.keys.has(key)) return key;
          top.keys.add(key);
        }
      }
      continue;
    }
    if (char === '{') {
      stack.push({ type: 'object', keys: new Set() });
      index += 1;
      continue;
    }
    if (char === '}') {
      stack.pop();
      index += 1;
      continue;
    }
    if (char === '[') {
      stack.push({ type: 'array' });
      index += 1;
      continue;
    }
    if (char === ']') {
      stack.pop();
      index += 1;
      continue;
    }
    index += 1;
  }
  return null;
}

export async function readControlJson(request: Request): Promise<JsonBodyResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, status: 400, error: 'invalid_json' };
    if (bytes > MAX_CONTROL_BODY_BYTES) return { ok: false, status: 413, error: 'payload_too_large' };
  }
  if (request.body === null) return { ok: false, status: 400, error: 'invalid_json' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_CONTROL_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, status: 413, error: 'payload_too_large' };
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return { ok: false, status: 400, error: 'invalid_json' };
    throw error;
  }
  try {
    const duplicate = findDuplicateProperty(text);
    if (duplicate !== null) return { ok: false, status: 400, error: 'duplicate_property' };
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, status: 400, error: 'invalid_json' };
    throw error;
  }
}
