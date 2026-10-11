import { expect, test } from 'bun:test';
import { captureOAuthCallback } from '../../src/oauth-callback';

test('captures one loopback callback while rejecting unrelated and duplicate requests', async () => {
  let listening!: (port: number) => void;
  const ready = new Promise<number>(resolve => { listening = resolve; });
  const captured = captureOAuthCallback({ port: 0, onListening: listening });
  const port = await ready;
  const base = `http://127.0.0.1:${port}`;
  expect((await fetch(`${base}/favicon.ico`)).status).toBe(400);
  expect((await fetch(`${base}/auth/callback?code=one&code=two&state=s&client_id=oaiapp_test`)).status).toBe(400);
  const callback = `${base}/auth/callback?code=one&state=s&client_id=oaiapp_test`;
  expect((await fetch(callback)).status).toBe(200);
  expect(await captured).toBe(callback);
});

test('capture timeout and cancellation release the listener', async () => {
  await expect(captureOAuthCallback({ port: 0, timeoutMs: 20 })).rejects.toThrow('timed out');
  const controller = new AbortController();
  controller.abort();
  await expect(captureOAuthCallback({ port: 0, signal: controller.signal })).rejects.toThrow('cancelled');
});
