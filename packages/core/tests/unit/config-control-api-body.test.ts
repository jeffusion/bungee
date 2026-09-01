import { describe, expect, test } from 'bun:test';
import { readControlJson } from '../../src/master-runtime/control-api-body';

function request(body: string): Request {
  return new Request('http://localhost/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('readControlJson duplicate property detection', () => {
  test('accepts valid JSON without duplicates', async () => {
    const result = await readControlJson(request('{"a":1,"b":{"c":2},"d":[1,2,3]}'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1, b: { c: 2 }, d: [1, 2, 3] });
  });

  test('rejects duplicate keys at root', async () => {
    const result = await readControlJson(request('{"a":1,"a":2}'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('duplicate_property');
  });

  test('rejects escaped-equivalent duplicate keys at root', async () => {
    const result = await readControlJson(request('{"a":1,"\\u0061":2}'));
    expect(result).toEqual({ ok: false, status: 400, error: 'duplicate_property' });
  });

  test('rejects duplicate keys in nested object', async () => {
    const result = await readControlJson(request('{"a":{"b":1,"b":2}}'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('duplicate_property');
  });

  test('rejects escaped-equivalent duplicate keys in nested object', async () => {
    const result = await readControlJson(request('{"a":{"b":1,"\\u0062":2}}'));
    expect(result).toEqual({ ok: false, status: 400, error: 'duplicate_property' });
  });

  test('accepts duplicate-looking keys in different objects', async () => {
    const result = await readControlJson(request('{"a":{"b":1},"c":{"b":2}}'));
    expect(result.ok).toBe(true);
  });

  test('does not treat array elements as object keys', async () => {
    const result = await readControlJson(request('{"a":[{"b":1},{"b":2}]}'));
    expect(result.ok).toBe(true);
  });

  test('handles escaped quotes and colons inside strings', async () => {
    const result = await readControlJson(request('{"a":"x:y","b":"\\"quoted\\"","c":1}'));
    expect(result.ok).toBe(true);
  });

  test('accepts distinct keys containing escaped quotes', async () => {
    const result = await readControlJson(request('{"a\\"x":1,"b\\"x":2}'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ 'a"x': 1, 'b"x': 2 });
  });

  test('rejects invalid UTF-8', async () => {
    const result = await readControlJson(new Request('http://localhost/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d]),
    }));
    expect(result).toEqual({ ok: false, status: 400, error: 'invalid_json' });
  });

  test('rejects malformed JSON', async () => {
    const result = await readControlJson(request('{"a":'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_json');
  });
});
