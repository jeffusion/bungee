import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { accessLogWriter } from '../../src/logger/access-log-writer';
import { fileLogWriter, FileLogWriter } from '../../src/logger/file-log-writer';
import { RequestLogger } from '../../src/logger/request-logger';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalAccessWrite = accessLogWriter.write;
const originalFileWrite = fileLogWriter.write;

afterEach(() => {
  accessLogWriter.write = originalAccessWrite;
  fileLogWriter.write = originalFileWrite;
});

describe('RequestLogger.complete', () => {
  for (const requestType of ['final', 'recovery'] as const) for (const phase of ['before-begin', 'pending', 'before-metadata']) {
    test(`serializes one terminal JSONL record even at the 100-row flush boundary: ${requestType}/${phase}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'bungee-file-transport-'));
      const sink = new FileLogWriter(root);
      try {
        for (let index = 0; index < 99; index++) await sink.write({ requestId: `warm-${index}`, timestamp: 0,
          method: 'GET', path: '/warm', status: 200, duration: 0 });
        const logger = new RequestLogger(new Request('http://localhost/file-transport'), { requestType }, {
          accessLogWriter: { write() {}, updateResponseBodyId() {}, updateProtocolOutcome() {}, updateTransportOutcome() {} },
          fileLogWriter: sink,
        });
        logger.deferFileLogUntilTransportObserved();
        if (phase === 'before-begin') await logger.complete(200);
        logger.beginTransport(200);
        if (phase === 'pending') await logger.complete(200);
        logger.updateTransportOutcome('completed');
        await logger.complete(200);
        await sink.flush();
        const rows = readFileSync(join(root, readdirSync(root)[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(rows.filter(row => row.path === '/file-transport')).toEqual([expect.objectContaining({ transportOutcome: 'completed' })]);
        expect(rows).toHaveLength(100);
      } finally { await sink.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
  test('unreturned attempts release deferred file records when superseded or the handler throws', async () => {
    for (const requestType of ['retry', 'final'] as const) {
      const rows: Record<string, any>[] = [];
      const logger = new RequestLogger(new Request('http://localhost/not-returned'), { requestType }, {
        accessLogWriter: { write() {}, updateResponseBodyId() {}, updateProtocolOutcome() {}, updateTransportOutcome() {} },
        fileLogWriter: { async write(entry) { rows.push(JSON.parse(JSON.stringify(entry))); } },
      });
      logger.deferFileLogUntilTransportObserved();
      logger.updateUpstreamTransportOutcome('cancelled', 'client_cancelled');
      await logger.complete(503);
      expect(rows).toHaveLength(0);
      logger.releaseUnreturnedTransportFileLog();
      await logger.complete(503);
      logger.releaseUnreturnedTransportFileLog();
      expect(rows).toEqual([expect.objectContaining({ transportOutcome: 'cancelled', transportCode: 'client_cancelled' })]);
    }
  });
  test('final byte observation cannot be overwritten by delayed upstream completion', () => {
    const updates: unknown[] = [];
    const logger = new RequestLogger(new Request('http://localhost/observed'), undefined, {
      accessLogWriter: { write() {}, updateResponseBodyId() {}, updateProtocolOutcome() {},
        updateTransportOutcome(_requestId, outcome, code) { updates.push([outcome, code]); } },
      fileLogWriter: { async write() {} },
    });
    logger.updateUpstreamTransportOutcome('completed');
    logger.beginTransport(200);
    logger.updateTransportOutcome('cancelled', 'client_cancelled');
    logger.updateUpstreamTransportOutcome('completed');
    expect(updates).toEqual([['completed', undefined], ['pending', undefined], ['cancelled', 'client_cancelled']]);
  });
  test('records why body storage skipped an oversized original request without affecting success', async () => {
    let entry: Record<string, any> | undefined;
    const logger = new RequestLogger(new Request('http://localhost/oversized-log'), undefined, {
      accessLogWriter: { write(value) { entry = value; }, updateResponseBodyId() {}, updateProtocolOutcome() {} },
      fileLogWriter: { async write() {} },
      bodyStorage: {
        async save() { return null; },
        getConfig() { return { enabled: true, maxSize: 4, retentionDays: 1 }; },
      },
    });
    logger.setOriginalRequestBody('ééé');
    await logger.complete(200, { success: true });
    expect(entry).toMatchObject({ status: 200, success: true });
    expect(entry?.processingSteps).toContainEqual(expect.objectContaining({
      step: 'body_recording_skipped', detail: { type: 'original-request', reason: 'size_limit', bytes: 6, maxBytes: 4 },
    }));
  });

  test('reuses one in-flight completion and enqueues once', async () => {
    const accessWrite = spyOn(accessLogWriter, 'write').mockImplementation(() => undefined);
    let resolveFileWrite!: () => void;
    const fileWrite = spyOn(fileLogWriter, 'write').mockImplementation(() => new Promise<void>((resolve) => {
      resolveFileWrite = resolve;
    }));
    const logger = new RequestLogger(new Request('http://localhost/concurrent'));

    const first = logger.complete(200);
    const second = logger.complete(200);
    expect(first).toBe(second);
    expect(accessWrite).toHaveBeenCalledTimes(1);
    expect(fileWrite).toHaveBeenCalledTimes(1);

    resolveFileWrite();
    await first;
  });

  test('retries a rejected file write without duplicating the access-log enqueue', async () => {
    const accessWrite = spyOn(accessLogWriter, 'write').mockImplementation(() => undefined);
    let attempts = 0;
    const fileWrite = spyOn(fileLogWriter, 'write').mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary file write failure');
    });
    const logger = new RequestLogger(new Request('http://localhost/file-retry'));

    await expect(logger.complete(200)).rejects.toThrow('temporary file write failure');
    await logger.complete(200);
    await logger.complete(200);

    expect(accessWrite).toHaveBeenCalledTimes(1);
    expect(fileWrite).toHaveBeenCalledTimes(2);
  });
});
