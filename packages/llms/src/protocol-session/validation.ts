import { fail, record, string, list, type JsonRecord } from '../responses-codec/common';
export function fields(value: JsonRecord, allowed: readonly string[], path: string, code = 'unsupported_request'): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail(code, 'Field cannot be represented by the target protocol', path ? `${path}.${key}` : key);
}
export function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean')
    fail('invalid_payload', 'Expected a boolean', path);
  return value;
}
export function integer(value: unknown, path: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    fail('invalid_payload', 'Expected an integer in the supported range', path);
  return value as number;
}
export function textParts(raw: unknown, path: string, style: 'chat' | 'anthropic' | 'gemini', role: string): JsonRecord[] {
  if (typeof raw === 'string')
    return [{ type: 'input_text', text: raw }];
  return list(raw, path).map((rawPart, index) => {
    const p = record(rawPart, path), at = `${path}[${index}]`;
    if (style === 'gemini') {
      fields(p, ['text', 'thought'], at, 'unsupported_content');
      if (p.thought === true)
        fail('unsupported_reasoning', 'Reasoning must be represented as a separate history item', at);
      return { type: 'input_text', text: string(p.text, at) };
    }
    if (style === 'chat' && p.type === 'image_url' && role === 'user') {
      fields(p, ['type', 'image_url'], at, 'unsupported_content');
      const image = record(p.image_url, at);
      fields(image, ['url', 'detail'], `${at}.image_url`, 'unsupported_content');
      return { type: 'input_image', image_url: string(image.url, at, true), ...(image.detail !== undefined ? { detail: image.detail } : {}) };
    }
    if (style === 'chat' && p.type === 'refusal' && role === 'assistant') { fields(p, ['type', 'refusal'], at, 'unsupported_content'); return { type: 'refusal', refusal: string(p.refusal, at) }; }
    if (p.type !== 'text')
      fail('unsupported_content', 'Content block cannot be represented by the target protocol', at);
    fields(p, ['type', 'text'], at, 'unsupported_content');
    return { type: 'input_text', text: string(p.text, at) };
  });
}
