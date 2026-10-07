import { expect, test } from 'bun:test';
import { observeTransportResponse } from '../../src/logger/transport-outcome';

test('HTTP errors and application error frames are independent of complete byte transport', async () => {
  for (const status of [200, 500]) {
    const payload = 'event: response.failed\ndata: {"error":{"code":"quota"}}\n\n';
    const records: unknown[] = [];
    const response = observeTransportResponse(new Response(payload, { status }), new AbortController().signal,
      (outcome, code) => records.push([outcome, code]));
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(payload);
    expect(records).toEqual([['completed', undefined]]);
  }
});

test('preserves opaque binary bytes and backpressure without pre-reading', async () => {
  let pulls = 0;
  const bytes = new Uint8Array([0, 255, 128, 13, 10]);
  const source = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
  const records: string[] = [];
  const response = observeTransportResponse(new Response(source), new AbortController().signal, outcome => records.push(outcome));
  await Promise.resolve();
  expect(pulls).toBe(0);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(records).toEqual(['completed']);
});

test('a read failure after HTTP 200 uses transport deadline evidence', async () => {
  const records: unknown[] = [];
  const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('socket closed')); } });
  const response = observeTransportResponse(new Response(source), new AbortController().signal,
    (outcome, code) => records.push([outcome, code]), () => 'request_timeout');
  await expect(response.text()).rejects.toThrow('socket closed');
  expect(records).toEqual([['failed', 'request_timeout']]);
});

test('cancel records a neutral lifecycle outcome and EOF is never overwritten by later abort', async () => {
  const abort = new AbortController();
  const cancelled: unknown[] = [];
  const response = observeTransportResponse(new Response(new ReadableStream({ cancel() {} }, { highWaterMark: 0 })), abort.signal,
    (outcome, code) => cancelled.push([outcome, code]));
  await response.body!.cancel();
  abort.abort();
  expect(cancelled).toEqual([['cancelled', undefined]]);
  const completeAbort = new AbortController();
  const completed: string[] = [];
  const finite = observeTransportResponse(new Response('done'), completeAbort.signal, outcome => completed.push(outcome));
  await finite.text();
  completeAbort.abort();
  expect(completed).toEqual(['completed']);
});

test('empty bodies complete and log sink exceptions do not affect response bytes', async () => {
  const records: string[] = [];
  const response = new Response(null, { status: 204 });
  expect(observeTransportResponse(response, new AbortController().signal, value => records.push(value))).toBe(response);
  expect(records).toEqual(['completed']);
  const finite = observeTransportResponse(new Response('ok'), new AbortController().signal, () => { throw new Error('log unavailable'); });
  expect(await finite.text()).toBe('ok');
});

test('cancellation with an in-flight pull tears down once and diagnostic code failures preserve stream errors', async () => {
  let cancelCount = 0;
  const records: string[] = [];
  const response = observeTransportResponse(new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelCount++; },
  }, { highWaterMark: 0 })), new AbortController().signal, value => records.push(value));
  const reader = response.body!.getReader();
  const read = reader.read(); await Promise.resolve();
  await reader.cancel(); await read;
  expect(cancelCount).toBe(1); expect(records).toEqual(['cancelled']);
  const failed = observeTransportResponse(new Response(new ReadableStream({
    pull(controller) { controller.error(new Error('original stream failure')); },
  })), new AbortController().signal, () => {}, () => { throw new Error('diagnostic failure'); });
  await expect(failed.text()).rejects.toThrow('original stream failure');
});

test('an evidenced deadline retains priority when a client cancellation arrives later', async () => {
  const abort = new AbortController(); const records: unknown[] = [];
  const response = observeTransportResponse(new Response(new ReadableStream({}, { highWaterMark: 0 })), abort.signal,
    (outcome, code) => records.push([outcome, code]), () => 'request_timeout');
  abort.abort(); await response.body!.cancel();
  expect(records).toEqual([['failed', 'request_timeout']]);
});
