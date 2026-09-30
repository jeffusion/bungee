import { describe, expect, test } from 'bun:test';
import { SSETerminalOutcome } from '../../src/worker/response/sse-terminal-outcome';

const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
const encoder = new TextEncoder();

describe('SSE terminal outcome at the client boundary', () => {
  test('recognizes a complete Responses terminal across byte boundaries and CRLF', () => {
    const observer = new SSETerminalOutcome();
    for (const byte of encoder.encode(completed.replaceAll('\n', '\r\n'))) observer.push(new Uint8Array([byte]));
    expect(observer.resolve({ status: 'cancelled' })).toEqual({ status: 'completed' });
  });

  test('does not promote an unfinished frame or a mention in generated text', () => {
    for (const text of [completed.trimEnd(), 'data: {"delta":"response.completed data: [DONE]"}\n\n']) {
      const observer = new SSETerminalOutcome();
      observer.push(encoder.encode(text));
      expect(observer.resolve({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
    }
  });

  test('recognizes Chat Completions and Anthropic terminal frames', () => {
    for (const text of ['data: [DONE]\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n']) {
      const observer = new SSETerminalOutcome();
      observer.push(encoder.encode(text));
      expect(observer.resolve({ status: 'cancelled' })).toEqual({ status: 'completed' });
    }
  });

  test('keeps protocol errors and incomplete results when followed by DONE', () => {
    for (const [text, status] of [
      ['data: {"type":"response.failed","response":{"status":"failed"}}\n\n', 'failed'],
      ['data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n', 'incomplete'],
      [completed + 'event: error\ndata: {"type":"error","error":{"message":"failure"}}\n\n', 'failed'],
    ] as const) {
      const observer = new SSETerminalOutcome();
      observer.push(encoder.encode(text + 'data: [DONE]\n\n'));
      expect(observer.resolve({ status: 'cancelled' }).status).toBe(status);
      expect(observer.resolve({ status: 'completed' }).status).toBe(status);
    }
  });

  test('a Responses DONE without its required terminal remains incomplete', () => {
    const observer = new SSETerminalOutcome();
    observer.push(encoder.encode('data: {"type":"response.created"}\n\ndata: [DONE]\n\n'));
    expect(observer.resolve({ status: 'cancelled' }).status).toBe('incomplete');
  });

  test('preserves converted Responses incompleteness when Chat ends with DONE', () => {
    const observer = new SSETerminalOutcome();
    observer.push(encoder.encode('data: {"choices":[{"finish_reason":"length","native_finish_reason":"max_output_tokens"}]}\n\ndata: [DONE]\n\n'));
    expect(observer.resolve({ status: 'cancelled' }).status).toBe('incomplete');
  });

  test('does not overwrite a real completion failure or request timeout', () => {
    const observer = new SSETerminalOutcome();
    observer.push(encoder.encode(completed));
    expect(observer.resolve({ status: 'failed', code: 'request_timeout' })).toEqual({ status: 'failed', code: 'request_timeout' });
  });

  test('bounds observation of oversized unfinished frames without fabricating success', () => {
    const observer = new SSETerminalOutcome();
    observer.push(encoder.encode(`data: ${'x'.repeat(1_100_000)}`));
    observer.push(encoder.encode('\n\n' + completed));
    expect(observer.resolve({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
  });

  test('retains an observed failure when a later unfinished frame exceeds the bound', () => {
    const observer = new SSETerminalOutcome();
    observer.push(encoder.encode('event: error\ndata: {"type":"error"}\n\n'));
    observer.push(encoder.encode(`data: ${'x'.repeat(1_100_000)}`));
    expect(observer.resolve({ status: 'cancelled' }).status).toBe('failed');
  });
});
