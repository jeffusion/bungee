import { expect, test } from 'bun:test';
import { formatSSELog } from '../src/sse-log';

test('SSE logs use event/data pairs for JSON values, text, empty data and DONE', () => {
  const text = '\uFEFF: heartbeat\n\nevent: named\nid: 7\nretry: 12\ndata: {"x":1}\n\n'
    + 'data: [1,2]\n\ndata: false\n\ndata: null\n\ndata: 0\n\n'
    + 'data: hello\ndata: world\n\nevent:\ndata:\n\ndata: [DONE]\n\n';
  const expected = [
    { event: 'named', data: { x: 1 } }, { event: 'message', data: [1, 2] },
    { event: 'message', data: false }, { event: 'message', data: null }, { event: 'message', data: 0 },
    { event: 'message', data: 'hello\nworld' }, { event: 'message', data: '' },
    { event: 'message', data: '[DONE]' },
  ];
  for (const ending of ['\n', '\r\n', '\r']) {
    expect(formatSSELog(text.replaceAll('\n', ending), 'Text/Event-Stream; charset=utf-8')).toEqual(expected);
  }
});

test('SSE parsing keeps named data blocks, skips comment-only frames and retains a final block', () => {
  expect(formatSSELog('event: first\nevent: last\ndata:  a:b\n\n: ping\n\nevent: discarded\n\ndata: tail', 'text/event-stream')).toEqual([
    { event: 'last', data: ' a:b' }, { event: 'message', data: 'tail' },
  ]);
  expect(formatSSELog(': ping\n\n', 'text/event-stream')).toEqual([]);
  expect(formatSSELog('', 'text/event-stream')).toEqual([]);
});

test('historical wrappers project to arrays without changing their source', () => {
  const body = { kind: 'sse_messages', totalMessages: 4, messages: [
    { index: 0, event: 'named', data: { x: 1 }, dataText: '{"x":1}' },
    { index: 1, dataText: 'hello' }, { index: 2, data: null, dataText: 'null' },
    { index: 3, done: true, dataText: '[DONE]' },
  ] };
  const original = structuredClone(body);
  expect(formatSSELog(body)).toEqual([
    { event: 'named', data: { x: 1 } }, { event: 'message', data: 'hello' },
    { event: 'message', data: null }, { event: 'message', data: '[DONE]' },
  ]);
  expect(body).toEqual(original);
});

test('ordinary JSON, text, encoded fallback and already formatted arrays stay intact', () => {
  const values = ['data: keep\n\n', { content: 'data: keep' }, [{ event: 'named', data: {} }],
    { encoding: 'base64', content_encoding: 'unknown', data: 'ZGF0YTo=' },
    { kind: 'sse_messages', messages: [null] }];
  for (const body of values) expect(formatSSELog(body, 'application/json')).toBe(body);
  expect(formatSSELog(values[3], 'text/event-stream')).toBe(values[3]);
});

test('SSE allocation reservations include many tiny events and propagate exhaustion', () => {
  let reserved = 0;
  expect(() => formatSSELog('data:\n\n'.repeat(100), 'text/event-stream', bytes => {
    reserved += bytes;
    if (reserved > 1024) throw new Error('capacity');
  })).toThrow('capacity');
});

test('missing response type requires explicit SSE negotiation and recognizable frames', () => {
  const text = '\uFEFF: ping\r\nevent: named\r\nid: 7\r\nretry: 12\r\ndata: {"x":1}\r\n\r\ndata: [DONE]';
  const expected = [{ event: 'named', data: { x: 1 } }, { event: 'message', data: '[DONE]' }];
  expect(formatSSELog(text, '', undefined, 'application/json, Text/Event-Stream; q=0.9')).toEqual(expected);
  for (const accept of ['', '*/*', 'application/text/event-stream', 'text/event-stream; q=0.00']) {
    expect(formatSSELog(text, '', undefined, accept)).toBe(text);
  }
  for (const media of ['application/json', 'text/plain', 'application/octet-stream']) {
    expect(formatSSELog(text, media, undefined, 'text/event-stream')).toBe(text);
  }
  for (const body of ['upstream failed', '{"error":"failed"}', ': ping\n\n', 'event: error\n\n', 'data: x\ninvalid text\n\n']) {
    expect(formatSSELog(body, '', undefined, 'text/event-stream')).toBe(body);
  }
});
