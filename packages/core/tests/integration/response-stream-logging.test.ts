import { afterAll as afterDataPlaneTests } from 'bun:test';
import { createDataPlaneRuntime } from '../helpers/data-plane-runtime';
const dataPlaneRuntime = await createDataPlaneRuntime();
const { dataPlaneBodyLogDir, dataPlaneFileLogDir } = dataPlaneRuntime;
import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import type { AppConfig, ModificationRules } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../../src/expression-engine';


const trackedRequestIds: string[] = [];
const trackedBodyIds: string[] = [];
let accessLogWriter: typeof import('../../src/logger/access-log-writer').accessLogWriter;
let bodyStorage: import('../../src/logger/body-storage').BodyStorageManager;
let RequestLogger: typeof import('../../src/logger/request-logger').RequestLogger;
let prepareResponse: typeof import('../../src/worker/response/processor').prepareResponse;
let fileLogWriter: typeof import('../../src/logger/file-log-writer').fileLogWriter;

const baseContext: ExpressionContext = {
  headers: {},
  body: {},
  url: {
    pathname: '/v1/messages',
    search: '',
    host: 'localhost',
    protocol: 'http:',
  },
  method: 'POST',
  env: {},
};

const emptyRules: ModificationRules = {};

beforeAll(async () => {

  ({ accessLogWriter } = await import('../../src/logger/access-log-writer'));
  const { BodyStorageManager } = await import('../../src/logger/body-storage');
  bodyStorage = new BodyStorageManager({}, dataPlaneBodyLogDir);
  ({ RequestLogger } = await import('../../src/logger/request-logger'));
  ({ prepareResponse } = await import('../../src/worker/response/processor'));
  ({ fileLogWriter } = await import('../../src/logger/file-log-writer'));
});

function createSSEBody(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function enqueueAccessLog(requestId: string): void {
  accessLogWriter.write({
    requestId,
    timestamp: Date.now(),
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    duration: 12,
  });
}

function getBodyFilePath(bodyId: string): string {
  return path.resolve(dataPlaneBodyLogDir, bodyId);
}

afterEach(async () => {
  await accessLogWriter.flush();
  const db = accessLogWriter.getDatabase();

  for (const requestId of trackedRequestIds.splice(0)) {
    db.prepare('DELETE FROM access_logs WHERE request_id = ?').run(requestId);
  }

  for (const bodyId of trackedBodyIds.splice(0)) {
    const filePath = getBodyFilePath(bodyId);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }
});

describe('prepareResponse streamed logging', () => {
  test('body logging discards cancelled partial streams without blocking', async () => {
    const reqLogger = new RequestLogger(new Request('http://localhost/v1/messages'), undefined, { bodyStorage });
    const steps = spyOn(reqLogger, 'addStep');
    const requestId = reqLogger.getRequestId();
    trackedRequestIds.push(requestId);
    let cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 });
    const config: AppConfig = { routes: [], logging: { body: { enabled: true, max_size: 64, retention_days: 1 } } };
    const prepared = await prepareResponse(
      new Response(source, { headers: { 'content-type': 'text/event-stream' } }), emptyRules, baseContext,
      { requestId }, reqLogger, config, undefined, undefined, undefined, undefined, false, true,
    );
    const reader = (prepared.body as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).done).toBe(false);
    const pending = reader.read();
    await reader.cancel('client disconnected');
    expect((await pending).done).toBe(true);
    expect(cancellations).toBe(1);
    await reqLogger.complete(200, { success: false });
    await accessLogWriter.flush();
    const row = accessLogWriter.getDatabase().query('SELECT resp_body_id FROM access_logs WHERE request_id=?').get(requestId) as { resp_body_id: string };
    expect(row.resp_body_id).toBeNull();
    expect(steps).toHaveBeenCalledWith('body_logging_incomplete', { direction: 'response', reason: 'cancelled', observer_incomplete: true });
    steps.mockRestore();
  });

  test('opaque SSE errors retain the HTTP-200 failure reason without forcing capture', async () => {
    for (const withPartialBody of [true, false]) {
      const reqLogger = new RequestLogger(new Request('http://localhost/v1/messages'), undefined, { bodyStorage });
      const requestId = reqLogger.getRequestId();
      trackedRequestIds.push(requestId);
      let sourceController!: ReadableStreamDefaultController<Uint8Array>;
      const source = new ReadableStream<Uint8Array>({ start(controller) {
        sourceController = controller;
        if (withPartialBody) controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"partial"}}\n\n'));
        else controller.error(new Error('upstream body failed'));
      } });
      const config: AppConfig = { routes: [], logging: { body: { enabled: true, max_size: 64, retention_days: 1 } } };
      const prepared = await prepareResponse(
        new Response(source, { headers: { 'content-type': 'text/event-stream' } }), emptyRules, baseContext,
        { requestId }, reqLogger, config, undefined, undefined, undefined, undefined, false, true,
      );
      const reader = (prepared.body as ReadableStream<Uint8Array>).getReader();
      if (withPartialBody) {
        expect((await reader.read()).value).toBeDefined();
        sourceController.error(new Error('upstream body failed'));
      }
      await expect(reader.read()).rejects.toThrow('upstream body failed');
      // Outcome and body updates can arrive before the final log is enqueued.
      reqLogger.updateProtocolOutcome('failed', false, 'body_limit');
      await reqLogger.complete(200, { success: false });
      await accessLogWriter.flush();
      const row = accessLogWriter.getDatabase().query('SELECT status,success,error_message,resp_body_id FROM access_logs WHERE request_id=?').get(requestId) as Record<string, any>;
      expect(row).toMatchObject({ status: 200, success: 0, error_message: 'Response stream failed (body_limit)' });
      expect(row.resp_body_id).toBeNull();
    }
  });

  test('fills failure reasons on already persisted records without overwriting existing explanations', async () => {
    const reqLogger = new RequestLogger(new Request('http://localhost/v1/messages'), undefined, { bodyStorage });
    const requestId = reqLogger.getRequestId();
    trackedRequestIds.push(requestId);
    await reqLogger.complete(200, { errorMessage: 'Specific upstream error' });
    await accessLogWriter.flush();
    reqLogger.updateProtocolOutcome('failed', false, 'body_limit');
    const row = accessLogWriter.getDatabase().query('SELECT success,error_message FROM access_logs WHERE request_id=?').get(requestId);
    expect(row).toEqual({ success: 0, error_message: 'Specific upstream error' });
  });

  test('applies pending resp_body_id update when log entry is written later', async () => {
    const reqLogger = new RequestLogger(new Request('http://localhost/v1/messages?stream=true', { method: 'POST' }), undefined, { bodyStorage });
    const requestId = reqLogger.getRequestId();
    trackedRequestIds.push(requestId);

    const expectedBodyId = `manual-${requestId}`;
    accessLogWriter.updateResponseBodyId(requestId, expectedBodyId);

    enqueueAccessLog(requestId);
    await accessLogWriter.flush();

    const row = accessLogWriter
      .getDatabase()
      .prepare('SELECT resp_body_id FROM access_logs WHERE request_id = ?')
      .get(requestId) as { resp_body_id: string | null } | null;

    expect(row).not.toBeNull();
    expect(row?.resp_body_id).toBe(expectedBodyId);
  });

  test('opaque SSE beyond logging size remains byte-exact and reports incomplete', async () => {
    const reqLogger = new RequestLogger(new Request('http://localhost/v1/messages?stream=true', { method: 'POST' }), undefined, { bodyStorage });
    const steps = spyOn(reqLogger, 'addStep');
    const requestId = reqLogger.getRequestId();
    trackedRequestIds.push(requestId);
    enqueueAccessLog(requestId);

    const longSuffix = 'TAIL_END_MARKER';
    const longDeltaText = `${'x'.repeat(1024)}${longSuffix}`;
    const streamChunks: string[] = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_full"}}\n\n',
    ];

    for (let i = 0; i < 18; i += 1) {
      const payload = JSON.stringify({
        type: 'content_block_delta',
        index: i,
        delta: {
          text: `segment-${i}-${longDeltaText}`,
        },
      });
      streamChunks.push('event: content_block_delta\n');
      streamChunks.push(`data: ${payload}\n\n`);
    }

    streamChunks.push('data: [DONE]\n\n');


    const config: AppConfig = {
      routes: [],
      logging: {
        body: {
          enabled: true,
          max_size: 64,
          retention_days: 1,
        },
      },
    };

    const upstreamResponse = new Response(
      createSSEBody(streamChunks),
      { headers: { 'content-type': 'text/event-stream' } }
    );

    const prepared = await prepareResponse(
      upstreamResponse,
      emptyRules,
      baseContext,
      { requestId },
      reqLogger,
      config
    );

    expect(prepared.body).not.toBeNull();
    const emittedText = await new Response(prepared.body as ReadableStream<Uint8Array>).text();
    expect(emittedText.includes('event: message_start')).toBeTrue();
    expect(emittedText.includes('data: [DONE]')).toBeTrue();
    expect(emittedText.includes(longSuffix)).toBeTrue();
    expect(emittedText).toBe(streamChunks.join(''));

    await accessLogWriter.flush();

    const row = accessLogWriter
      .getDatabase()
      .prepare('SELECT resp_body_id FROM access_logs WHERE request_id = ?')
      .get(requestId) as { resp_body_id: string | null } | null;

    expect(row).not.toBeNull();
    expect(row?.resp_body_id).toBeNull();
    expect(steps).toHaveBeenCalledWith('body_logging_incomplete', { direction: 'response', reason: 'size_limit', observer_incomplete: true });
    steps.mockRestore();
  });

  test('does not record streamed body when body logging is disabled', async () => {
    const reqLogger = new RequestLogger(new Request('http://localhost/v1/messages?stream=true', { method: 'POST' }), undefined, { bodyStorage });
    const requestId = reqLogger.getRequestId();
    trackedRequestIds.push(requestId);
    enqueueAccessLog(requestId);

    const config: AppConfig = {
      routes: [],
      logging: {
        body: {
          enabled: false,
          max_size: 5_120,
          retention_days: 1,
        },
      },
    };

    const upstreamResponse = new Response(
      createSSEBody([
        'event: message_start\n',
        'data: {"type":"message_start"}\n\n',
        'data: [DONE]\n\n',
      ]),
      { headers: { 'content-type': 'text/event-stream' } }
    );

    const prepared = await prepareResponse(
      upstreamResponse,
      emptyRules,
      baseContext,
      { requestId },
      reqLogger,
      config
    );

    expect(prepared.body).not.toBeNull();
    await new Response(prepared.body as ReadableStream<Uint8Array>).text();

    await accessLogWriter.flush();

    const row = accessLogWriter
      .getDatabase()
      .prepare('SELECT resp_body_id FROM access_logs WHERE request_id = ?')
      .get(requestId) as { resp_body_id: string | null } | null;

    expect(row).not.toBeNull();
    expect(row?.resp_body_id).toBeNull();
  });

  test('writes the final protocol outcome and code to SQLite and file logs', async () => {
    const reqLogger = new RequestLogger(new Request('http://localhost/v1/messages'), undefined, { bodyStorage });
    const requestId = reqLogger.getRequestId();
    trackedRequestIds.push(requestId);

    await reqLogger.complete(502, {
      protocolOutcome: 'failed',
      protocolCode: 'conversion_failed',
      success: false,
    });
    await accessLogWriter.flush();
    const row = accessLogWriter.getDatabase()
      .prepare('SELECT protocol_outcome, protocol_code, success FROM access_logs WHERE request_id = ?')
      .get(requestId) as { protocol_outcome: string; protocol_code: string; success: number } | null;
    expect(row).toEqual({ protocol_outcome: 'failed', protocol_code: 'conversion_failed', success: 0 });

    await fileLogWriter.flush();
    const filePath = path.join(dataPlaneFileLogDir, `access-${new Date().toISOString().split('T')[0]}.log`);
    const entries = (await fs.promises.readFile(filePath, 'utf8'))
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find(entry => entry.requestId === requestId)).toMatchObject({
      protocolOutcome: 'failed',
      protocolCode: 'conversion_failed',
      success: false,
    });
  });
});

afterDataPlaneTests(() => dataPlaneRuntime.close());
