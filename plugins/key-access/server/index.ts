import { definePlugin } from '../../../packages/core/src/plugin.types';
export { createIngress } from './policy';
export default definePlugin(class {
  static readonly name = 'key-access';
  static readonly version = '1.0.0';
  register() {}
  resolveAdmissionModel(input: {url: string; body: unknown}): string | null {
    const url = new URL(input.url);
    const gemini = /\/models\/([^/:]+):(?:streamGenerateContent|generateContent)$/.exec(url.pathname);
    if (gemini) {
      try { return decodeURIComponent(gemini[1]!); } catch { return null; }
    }
    // Admission sees the final fetch body after protocol/model rewrites and
    // serialization, rather than the earlier parsed request object.
    let body = input.body;
    try {
      if (typeof body === 'string') body = JSON.parse(body);
      else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const bytes = body instanceof ArrayBuffer ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      }
    } catch { return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const model = (body as Record<string, unknown>).model;
    return typeof model === 'string' && model.length > 0 ? model : null;
  }
});
