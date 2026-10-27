import { createHash } from 'node:crypto';
import { bounded, fail, string, record, list, serialized, type JsonRecord, type ResponsesCodecLimits } from '../responses-codec/common';
import { fields, integer } from './validation';

// Wire convention: LiteLLM cfe0100e1fca613e7b1af27dd1fe4807ca4d1d1a,
// litellm/litellm_core_utils/prompt_templates/factory.py (MIT).
// Copyright (c) 2023 Berri AI. MIT permission and warranty terms: ../../../../LICENSE.
const signatureSeparator = '__thought__';

export function checkedSignature(value: unknown, maxBytes: number): string {
  const signature = bounded(string(value, 'thoughtSignature', true), maxBytes, 'thoughtSignature');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 === 1
    || (signature.includes('=') && signature.length % 4 !== 0)
    || Buffer.from(signature, 'base64').toString('base64').replace(/=+$/, '') !== signature.replace(/=+$/, ''))
    fail('invalid_tool_arguments', 'Invalid Gemini thought signature encoding', 'thoughtSignature');
  return signature;
}

const envelopePrefix = 'bungee_gemini:';
export const geminiEnvelopeBytes = (payloadBytes: number): number => envelopePrefix.length + Math.ceil(payloadBytes * 4 / 3);
type SignedPart = { length: number; hash: string; signature?: string; textAbsent?: boolean };
type SignedItem = { id: string; thought: boolean; parts: SignedPart[] };
export const geminiTextHash = (text: string): string => createHash('sha256').update(text).digest('base64url');

/** Provider-bound replay data travels in a Responses opaque reasoning item, never in a server cache. */
export function geminiSignatureItem(items: SignedItem[], budget: ResponsesCodecLimits): JsonRecord {
  const payload = serialized({ version: 1, items }, budget.maxArgumentBytes, 'Gemini signatures');
  return { type: 'reasoning', id: `rs_gemini_${crypto.randomUUID().replaceAll('-', '')}`, summary: [],
    encrypted_content: bounded(envelopePrefix + Buffer.from(payload).toString('base64url'), budget.maxArgumentBytes, 'Gemini signatures') };
}

export function readGeminiSignatures(item: JsonRecord, budget: ResponsesCodecLimits): SignedItem[] {
  fields(item, ['type', 'id', 'summary', 'encrypted_content', 'status'], 'Gemini signatures', 'unsupported_reasoning');
  if (item.type !== 'reasoning' || list(item.summary, 'summary').length) fail('unsupported_reasoning', 'Invalid Gemini signature carrier');
  string(item.id, 'signature item id', true);
  const opaque = bounded(string(item.encrypted_content, 'encrypted_content', true), budget.maxArgumentBytes, 'Gemini signatures');
  if (!opaque.startsWith(envelopePrefix)) fail('unsupported_reasoning', 'Native encrypted reasoning cannot be restored to Gemini');
  const encoded = opaque.slice(envelopePrefix.length), bytes = Buffer.from(encoded, 'base64url');
  if (!encoded || bytes.toString('base64url') !== encoded) fail('unsupported_reasoning', 'Invalid Gemini signature carrier encoding');
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { fail('unsupported_reasoning', 'Invalid Gemini signature carrier JSON'); }
  const body = record(raw, 'Gemini signatures');
  fields(body, ['version', 'items'], 'Gemini signatures', 'unsupported_reasoning');
  if (body.version !== 1) fail('unsupported_reasoning', 'Unknown Gemini signature format');
  const ids = new Set<string>(); let partCount = 0;
  const result = list(body.items, 'signature items').map(raw => {
    const item = record(raw, 'signature item');
    fields(item, ['id', 'thought', 'parts'], 'signature item', 'unsupported_reasoning');
    const id = string(item.id, 'signed item id', true);
    if (ids.has(id) || typeof item.thought !== 'boolean') fail('unsupported_reasoning', 'Invalid signed item identity');
    ids.add(id);
    const parts = list(item.parts, 'signed parts').map(raw => {
      if (++partCount > budget.maxItems) fail('resource_limit', 'Too many signed Gemini parts');
      const part = record(raw, 'signed part');
      fields(part, ['length', 'hash', 'signature', 'textAbsent'], 'signed part', 'unsupported_reasoning');
      const length = integer(part.length, 'signed part length'), hash = string(part.hash, 'signed part hash', true);
      if (!/^[A-Za-z0-9_-]{43}$/.test(hash)) fail('unsupported_reasoning', 'Invalid signed part hash');
      const signature = part.signature === undefined ? undefined : checkedSignature(part.signature, budget.maxArgumentBytes);
      if (part.textAbsent !== undefined && (part.textAbsent !== true || length !== 0 || signature === undefined)) fail('unsupported_reasoning', 'Invalid empty signed part');
      return { length, hash, ...(signature === undefined ? {} : { signature }), ...(part.textAbsent ? { textAbsent: true } : {}) };
    });
    if (!parts.some(p => p.signature !== undefined)) fail('unsupported_reasoning', 'Signature carrier has no signature');
    return { id, thought: item.thought as boolean, parts };
  });
  if (!result.length || result.length > budget.maxItems) fail('unsupported_reasoning', 'Invalid signature item count');
  return result;
}

export function restoreGeminiHistory(input: unknown, budget: ResponsesCodecLimits) {
  const original = typeof input === 'string' ? [] : list(input, 'input').map(raw => record(raw, 'input item'));
  const carriers = new Set<JsonRecord>(), parts = new Map<string, JsonRecord[]>(), ids = new Map<string, number>();
  original.forEach((item, i) => {
    if (typeof item.id === 'string') {
      if (ids.has(item.id)) fail('invalid_tool_history', 'Duplicate history item id', 'input.id');
      ids.set(item.id, i);
    }
  });
  original.forEach((carrier, index) => {
    if (carrier.encrypted_content == null) return;
    const signed = readGeminiSignatures(carrier, budget); carriers.add(carrier);
    let previous = -1;
    for (const item of signed) {
      const at = ids.get(item.id);
      if (at === undefined || at >= index || at <= previous || parts.has(item.id)) fail('unsupported_reasoning', 'Signed history reference is missing or ambiguous');
      previous = at;
      const source = original[at]!;
      if (item.thought ? source.type !== 'reasoning' || source.encrypted_content != null : source.role !== 'assistant' || (source.type !== undefined && source.type !== 'message')) fail('unsupported_reasoning', 'Signed history item kind changed');
      const content = item.thought ? list(source.summary, 'summary') : typeof source.content === 'string' ? [{ type: 'output_text', text: source.content }] : list(source.content, 'content');
      const text = content.map(raw => {
        const p = record(raw, 'signed text');
        if (p.type !== (item.thought ? 'summary_text' : 'output_text') && !(p.type === 'input_text' && !item.thought)) fail('unsupported_reasoning', 'Signed history content kind changed');
        return string(p.text, 'signed text');
      }).join('');
      let offset = 0;
      const restored = item.parts.map(part => {
        const value = text.slice(offset, offset + part.length); offset += part.length;
        if (value.length !== part.length || geminiTextHash(value) !== part.hash) fail('unsupported_reasoning', 'Signed history text changed');
        return { ...(part.textAbsent ? {} : { text: value }), ...(item.thought ? { thought: true } : {}), ...(part.signature === undefined ? {} : { thoughtSignature: part.signature }) };
      });
      if (offset !== text.length) fail('unsupported_reasoning', 'Signed history text was not fully consumed');
      parts.set(item.id, restored);
    }
  });
  return { input: typeof input === 'string' ? input : original.filter(item => !carriers.has(item)), parts,
    canonicalHistory(decoded: JsonRecord[]): JsonRecord[] {
      if (!carriers.size) return decoded;
      let next = 0;
      return original.flatMap(item => carriers.has(item) ? [item] : item.type === 'additional_tools' ? [] : [decoded[next++]!]);
    } };
}

export function encodeGeminiCallId(id: string, signature: unknown, maxBytes: number): string {
  if (id.includes(signatureSeparator))
    fail('invalid_tool_arguments', 'Gemini call id contains the signature separator', 'functionCall.id');
  return signature === undefined ? id : `${id}${signatureSeparator}${checkedSignature(signature, maxBytes)}`;
}

export function decodeGeminiCallId(value: string, maxBytes: number): { id: string; thoughtSignature?: string } {
  const separator = value.indexOf(signatureSeparator);
  if (separator < 0) return { id: value };
  const id = string(value.slice(0, separator), 'functionCall.id', true);
  return { id, thoughtSignature: checkedSignature(value.slice(separator + signatureSeparator.length), maxBytes) };
}
