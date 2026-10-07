import { afterEach, describe, it, expect } from 'bun:test';
import { createRequestSnapshot, readSnapshotJson, RequestBodyTooLargeError } from '../../src/worker/request/snapshot';

const owned: Array<NonNullable<Awaited<ReturnType<typeof createRequestSnapshot>>['bodySource']>> = [];
afterEach(() => { for (const source of owned.splice(0)) source.dispose(); });
async function capture(...args: Parameters<typeof createRequestSnapshot>) { const snapshot = await createRequestSnapshot(...args); owned.push(snapshot.bodySource!); return snapshot; }

describe('createRequestSnapshot', () => {
  it('should capture request without body', async () => {
    const req = new Request('http://localhost/test', {
      method: 'GET',
      headers: {
        'User-Agent': 'test',
        'Accept': 'application/json'
      }
    });

    const snapshot = await capture(req);

    expect(snapshot.method).toBe('GET');
    expect(snapshot.url).toBe('http://localhost/test');
    expect(snapshot.headers['user-agent']).toBe('test');
    expect(snapshot.headers['accept']).toBe('application/json');
    expect(snapshot.body).toBeUndefined();
    expect(snapshot.is_json_body).toBe(false);
  });

  it('should capture metadata and read JSON only on demand', async () => {
    const testData = {
      name: 'test',
      value: 123,
      nested: { key: 'value' }
    };

    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testData)
    });

    const snapshot = await capture(req);

    expect(snapshot.method).toBe('POST');
    expect(snapshot.body).toBeUndefined();
    expect(snapshot.is_json_body).toBe(false);
    await readSnapshotJson(snapshot, 'test-read');
    expect(snapshot.is_json_body).toBe(true);
    expect(snapshot.body).toEqual(testData);
    expect(snapshot.content_type).toBe('application/json');

    // Verify deep clone
    expect(snapshot.body).not.toBe(testData);
    snapshot.body.name = 'modified';
    expect(testData.name).toBe('test'); // Original unchanged
  });

  it('should forward binary body without parsing', async () => {
    const binaryData = new Uint8Array([1, 2, 3, 4, 5]);

    const req = new Request('http://localhost/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body: binaryData
    });

    const snapshot = await capture(req);

    expect(snapshot.method).toBe('POST');
    expect(snapshot.is_json_body).toBe(false);
    expect(snapshot.body).toBeUndefined();
    expect(snapshot.content_type).toBe('application/octet-stream');

    // Verify ArrayBuffer content
    const view = new Uint8Array(await new Response(snapshot.bodySource!.take()).arrayBuffer());
    expect(Array.from(view)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should reject declared bodies above the default 50MB limit', async () => {
    const req = new Request('http://localhost/upload', {
      method: 'POST',
      headers: {
        'Content-Length': String(51 * 1024 * 1024),
        'Content-Type': 'application/json'
      },
      body: '{}' // Actual body doesn't matter, header is checked first
    });

    await expect(createRequestSnapshot(req)).rejects.toThrow(
      /request_body_too_large/
    );
  });

  it('accepts JSON above the old 10MB limit with the default and configured limits', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(11 * 1024 * 1024) });
    for (const limit of [undefined, '12mb']) {
      const req = new Request('http://localhost/upload', {
        method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length) }, body,
      });
      const snapshot = await capture(req, limit);
      await readSnapshotJson(snapshot, 'large-json');
      expect(snapshot.body.data.length).toBe(11 * 1024 * 1024);
      expect(req.bodyUsed).toBe(true);
    }
  });

  it('rejects a declared oversized body without reading it', async () => {
    let reads = 0;
    const req = new Request('http://localhost/upload', {
      method: 'POST', headers: { 'content-length': '1025' },
      body: new ReadableStream({ pull() { reads += 1; } }, { highWaterMark: 0 }),
    });
    await expect(createRequestSnapshot(req, '1kb')).rejects.toMatchObject({
      status: 413, code: 'request_body_too_large', maxBytes: 1024, receivedBytes: 1025,
    });
    expect(reads).toBe(0);
  });

  it('enforces the actual byte limit with missing or understated content-length', async () => {
    for (const headers of [new Headers(), new Headers({ 'content-length': '1' })]) {
      let cancelled = false;
      let reads = 0;
      const req = new Request('http://localhost/upload', {
        method: 'POST', headers,
        body: new ReadableStream({
          pull(controller) {
            reads += 1;
            controller.enqueue(new Uint8Array(600));
          },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }),
      });
      const snapshot = await capture(req, '1kb');
      expect(reads).toBe(0);
      await expect(new Response(snapshot.bodySource!.take()).arrayBuffer()).rejects.toMatchObject({ status: 413, code: 'request_body_too_large' });
      await Bun.sleep(0);
      expect(cancelled).toBe(true);
      expect(reads).toBeLessThanOrEqual(3);
    }
  });

  it('allows exact UTF-8 byte boundaries and preserves binary bytes', async () => {
    const json = JSON.stringify({ data: 'é' });
    const req = new Request('http://localhost/upload', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: json,
    });
    const size = Buffer.byteLength(json);
    const exact = await capture(req, `${size}b`);
    expect(await readSnapshotJson(exact, 'exact')).toEqual({ data: 'é' });
    const below = await capture(new Request('http://localhost/upload', { method: 'POST', body: json }), `${size - 1}b`);
    await expect(readSnapshotJson(below, 'below')).rejects.toMatchObject({ status: 413 });
    const binary = new Uint8Array([0, 255, 128, 42]);
    const snapshot = await capture(new Request('http://localhost/upload', {
      method: 'POST', body: binary,
    }), '4b');
    expect(new Uint8Array(await new Response(snapshot.bodySource!.take()).arrayBuffer())).toEqual(binary);
  });

  it('should reject invalid JSON only on an explicit read', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: 'invalid json {'
    });

    const snapshot = await capture(req);
    expect(req.bodyUsed).toBe(false);
    expect(snapshot.body).toBeUndefined();
    await expect(readSnapshotJson(snapshot, 'invalid')).rejects.toMatchObject({ status: 400, code: 'invalid_json_body' });
  });

  it('should handle JSON with application/json; charset=utf-8', async () => {
    const testData = { test: 'data' };

    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(testData)
    });

    const snapshot = await capture(req);

    expect(snapshot.body).toBeUndefined();
    expect(snapshot.is_json_body).toBe(false);
    await readSnapshotJson(snapshot, 'test-read');
    expect(snapshot.is_json_body).toBe(true);
    expect(snapshot.body).toEqual(testData);
  });

  it('should capture all headers', async () => {
    const req = new Request('http://localhost/test', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer token123',
        'X-Custom-Header': 'custom-value',
        'Accept-Language': 'en-US'
      }
    });

    const snapshot = await capture(req);

    expect(snapshot.headers['authorization']).toBe('Bearer token123');
    expect(snapshot.headers['x-custom-header']).toBe('custom-value');
    expect(snapshot.headers['accept-language']).toBe('en-US');
  });

  it('should handle empty JSON body', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}'
    });

    const snapshot = await capture(req);

    expect(snapshot.body).toBeUndefined();
    expect(snapshot.is_json_body).toBe(false);
    await readSnapshotJson(snapshot, 'test-read');
    expect(snapshot.is_json_body).toBe(true);
    expect(snapshot.body).toEqual({});
  });

  it('should handle form data body as binary', async () => {
    const formData = new FormData();
    formData.append('field1', 'value1');
    formData.append('field2', 'value2');

    const req = new Request('http://localhost/form', {
      method: 'POST',
      body: formData
    });

    const snapshot = await capture(req);

    expect(snapshot.is_json_body).toBe(false);
    expect(snapshot.body).toBeUndefined();
    expect((await new Response(snapshot.bodySource!.take()).arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('should create independent snapshots from separately owned requests', async () => {
    const testData = { count: 0 };

    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testData)
    });

    const snapshot1 = await capture(req);
    const snapshot2 = await capture(new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(testData) }));
    await readSnapshotJson(snapshot1, 'independent');
    await readSnapshotJson(snapshot2, 'independent');

    // Modify snapshot1
    snapshot1.body.count = 100;
    snapshot1.headers['x-modified'] = 'true';

    // snapshot2 should be unaffected
    expect(snapshot2.body.count).toBe(0);
    expect(snapshot2.headers['x-modified']).toBeUndefined();
  });
});
