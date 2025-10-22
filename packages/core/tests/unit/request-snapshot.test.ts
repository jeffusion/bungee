import { describe, it, expect } from 'bun:test';
import { createRequestSnapshot } from '../../src/worker/request/snapshot';

describe('createRequestSnapshot', () => {
  it('should capture request without body', async () => {
    const req = new Request('http://localhost/test', {
      method: 'GET',
      headers: {
        'User-Agent': 'test',
        'Accept': 'application/json'
      }
    });

    const snapshot = await createRequestSnapshot(req);

    expect(snapshot.method).toBe('GET');
    expect(snapshot.url).toBe('http://localhost/test');
    expect(snapshot.headers['user-agent']).toBe('test');
    expect(snapshot.headers['accept']).toBe('application/json');
    expect(snapshot.body).toBeNull();
    expect(snapshot.isJsonBody).toBe(false);
  });

  it('should capture JSON body correctly', async () => {
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

    const snapshot = await createRequestSnapshot(req);

    expect(snapshot.method).toBe('POST');
    expect(snapshot.isJsonBody).toBe(true);
    expect(snapshot.body).toEqual(testData);
    expect(snapshot.contentType).toBe('application/json');

    // Verify deep clone
    expect(snapshot.body).not.toBe(testData);
    snapshot.body.name = 'modified';
    expect(testData.name).toBe('test'); // Original unchanged
  });

  it('should capture binary body as ArrayBuffer', async () => {
    const binaryData = new Uint8Array([1, 2, 3, 4, 5]);

    const req = new Request('http://localhost/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body: binaryData
    });

    const snapshot = await createRequestSnapshot(req);

    expect(snapshot.method).toBe('POST');
    expect(snapshot.isJsonBody).toBe(false);
    expect(snapshot.body).toBeInstanceOf(ArrayBuffer);
    expect(snapshot.contentType).toBe('application/octet-stream');

    // Verify ArrayBuffer content
    const view = new Uint8Array(snapshot.body);
    expect(Array.from(view)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should reject body larger than 10MB', async () => {
    const req = new Request('http://localhost/upload', {
      method: 'POST',
      headers: {
        'Content-Length': String(11 * 1024 * 1024), // 11MB
        'Content-Type': 'application/json'
      },
      body: '{}' // Actual body doesn't matter, header is checked first
    });

    await expect(createRequestSnapshot(req)).rejects.toThrow(
      /Request body too large for failover/
    );
  });

  it('should reject invalid JSON body', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: 'invalid json {'
    });

    await expect(createRequestSnapshot(req)).rejects.toThrow(/Invalid JSON body/);
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

    const snapshot = await createRequestSnapshot(req);

    expect(snapshot.isJsonBody).toBe(true);
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

    const snapshot = await createRequestSnapshot(req);

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

    const snapshot = await createRequestSnapshot(req);

    expect(snapshot.isJsonBody).toBe(true);
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

    const snapshot = await createRequestSnapshot(req);

    expect(snapshot.isJsonBody).toBe(false);
    expect(snapshot.body).toBeInstanceOf(ArrayBuffer);
    expect(snapshot.body.byteLength).toBeGreaterThan(0);
  });

  it('should create independent snapshots', async () => {
    const testData = { count: 0 };

    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testData)
    });

    const snapshot1 = await createRequestSnapshot(req.clone());
    const snapshot2 = await createRequestSnapshot(req.clone());

    // Modify snapshot1
    snapshot1.body.count = 100;
    snapshot1.headers['x-modified'] = 'true';

    // snapshot2 should be unaffected
    expect(snapshot2.body.count).toBe(0);
    expect(snapshot2.headers['x-modified']).toBeUndefined();
  });
});
