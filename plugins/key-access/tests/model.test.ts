import {expect, test} from 'bun:test';
import KeyAccess from '../server/index';

const plugin = new KeyAccess();
test.each(['generateContent', 'streamGenerateContent'])('final Gemini URL wins over body model for %s', operation => {
  expect(plugin.resolveAdmissionModel({url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:${operation}?key=redacted`, body: {model: 'earlier-body-model'}})).toBe('gemini-2.5-pro');
  expect(plugin.resolveAdmissionModel({url: `https://example.test/models/gemini%2D2.5%2Dflash:${operation}`, body: null})).toBe('gemini-2.5-flash');
});
test('final ordinary URL uses rewritten body model without prefix matching', () => {
  expect(plugin.resolveAdmissionModel({url: 'https://example.test/v1/chat/completions', body: {model: 'gpt-4o-mini-2026'}})).toBe('gpt-4o-mini-2026');
  expect(plugin.resolveAdmissionModel({url: 'https://example.test/models/other:countTokens', body: {model: 'body-model'}})).toBe('body-model');
});
test.each([null, [], 'gpt-4o', {}, {model: ''}, {model: 42}].map(body => ({body})))('missing or invalid body model returns null: %j', ({body}) => {
  expect(plugin.resolveAdmissionModel({url: 'https://example.test/v1/chat/completions', body})).toBeNull();
});
test('malformed Gemini encoding fails closed instead of falling back to body', () => {
  expect(plugin.resolveAdmissionModel({url: 'https://example.test/models/%E0%A4:generateContent', body: {model: 'fallback'}})).toBeNull();
});
test('serialized final fetch bodies preserve the exact model', () => {
  const text = JSON.stringify({model:'allowed-model',messages:[]});
  const bytes = new TextEncoder().encode(text);
  for (const body of [text, bytes, bytes.buffer]) {
    expect(plugin.resolveAdmissionModel({url:'https://example.test/v1/chat/completions',body})).toBe('allowed-model');
  }
  const padded = new Uint8Array(bytes.length+2); padded.set(bytes,1);
  expect(plugin.resolveAdmissionModel({url:'https://example.test/v1/chat/completions',body:padded.subarray(1,-1)})).toBe('allowed-model');
});
test.each(['{broken', 'null', '[]', '42', '{"model":42}', new Uint8Array([0xff])])('invalid serialized bodies fail closed: %j', body => {
  expect(plugin.resolveAdmissionModel({url:'https://example.test/v1/chat/completions',body})).toBeNull();
});
