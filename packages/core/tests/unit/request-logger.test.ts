import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { accessLogWriter } from '../../src/logger/access-log-writer';
import { fileLogWriter } from '../../src/logger/file-log-writer';
import { RequestLogger } from '../../src/logger/request-logger';

const originalAccessWrite = accessLogWriter.write;
const originalFileWrite = fileLogWriter.write;

afterEach(() => {
  accessLogWriter.write = originalAccessWrite;
  fileLogWriter.write = originalFileWrite;
});

describe('RequestLogger.complete', () => {
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
