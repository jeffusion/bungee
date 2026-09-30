import { describe, test, expect } from 'bun:test';
import { createRequestSnapshot, ensureSnapshotBodyCloned } from '../src/worker/request/snapshot';
import type { RequestSnapshot } from '../src/worker/types';

describe('Request Snapshot', () => {
  describe('createRequestSnapshot', () => {
    test('应该正确创建 JSON body 快照（不立即克隆）', async () => {
      const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] };
      const req = new Request('https://example.com/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });

      const snapshot = await createRequestSnapshot(req);

      expect(snapshot.method).toBe('POST');
      expect(snapshot.url).toBe('https://example.com/api');
      expect(snapshot.is_json_body).toBe(true);
      expect(snapshot.body).toEqual(body);
      expect(snapshot.is_body_cloned).toBe(false); // 延迟克隆：首次不克隆
    });

    test('应该正确创建非 JSON body 快照（ArrayBuffer）', async () => {
      const binaryData = new Uint8Array([1, 2, 3, 4, 5]);
      const req = new Request('https://example.com/api', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: binaryData
      });

      const snapshot = await createRequestSnapshot(req);

      expect(snapshot.method).toBe('POST');
      expect(snapshot.is_json_body).toBe(false);
      expect(snapshot.body).toBeInstanceOf(ArrayBuffer);
      expect(snapshot.is_body_cloned).toBe(false);
    });

    test('应该正确捕获请求头', async () => {
      const req = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          'authorization': 'Bearer token123',
          'x-custom-header': 'custom-value'
        }
      });

      const snapshot = await createRequestSnapshot(req);

      expect(snapshot.headers['authorization']).toBe('Bearer token123');
      expect(snapshot.headers['x-custom-header']).toBe('custom-value');
    });

    test('应该拒绝过大的请求体', async () => {
      const req = new Request('https://example.com/api', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(51 * 1024 * 1024) // 超过默认 50MB 限制
        },
        body: JSON.stringify({ data: 'x' })
      });

      await expect(createRequestSnapshot(req)).rejects.toThrow(/too large/);
    });

    test('应该处理无 body 的请求', async () => {
      const req = new Request('https://example.com/api', {
        method: 'GET'
      });

      const snapshot = await createRequestSnapshot(req);

      expect(snapshot.body).toBeNull();
      expect(snapshot.is_body_cloned).toBe(false);
    });
  });

  describe('ensureSnapshotBodyCloned', () => {
    test('应该在首次调用时执行深度克隆', () => {
      const originalBody = { nested: { value: 42 } };
      const snapshot: RequestSnapshot = {
        method: 'POST',
        url: 'https://example.com',
        headers: {},
        body: originalBody,
        content_type: 'application/json',
        is_json_body: true,
        is_body_cloned: false
      };

      // 执行克隆
      ensureSnapshotBodyCloned(snapshot);

      expect(snapshot.is_body_cloned).toBe(true);
      expect(snapshot.body).toEqual(originalBody);
      // 验证是深度克隆（修改原对象不影响快照）
      originalBody.nested.value = 999;
      expect(snapshot.body.nested.value).toBe(42);
    });

    test('应该跳过已克隆的快照', () => {
      const body = { value: 1 };
      const snapshot: RequestSnapshot = {
        method: 'POST',
        url: 'https://example.com',
        headers: {},
        body,
        content_type: 'application/json',
        is_json_body: true,
        is_body_cloned: true // 已标记为克隆
      };

      // 保存原始引用
      const originalRef = snapshot.body;

      // 再次调用应该不做任何操作
      ensureSnapshotBodyCloned(snapshot);

      expect(snapshot.body).toBe(originalRef); // 同一引用，未重新克隆
    });

    test('应该跳过非 JSON body', () => {
      const snapshot: RequestSnapshot = {
        method: 'POST',
        url: 'https://example.com',
        headers: {},
        body: new ArrayBuffer(10),
        content_type: 'application/octet-stream',
        is_json_body: false,
        is_body_cloned: false
      };

      const originalRef = snapshot.body;

      ensureSnapshotBodyCloned(snapshot);

      expect(snapshot.body).toBe(originalRef); // ArrayBuffer 不需要克隆
      expect(snapshot.is_body_cloned).toBe(false); // 保持原状态
    });

    test('应该跳过空 body', () => {
      const snapshot: RequestSnapshot = {
        method: 'GET',
        url: 'https://example.com',
        headers: {},
        body: null,
        content_type: '',
        is_json_body: true,
        is_body_cloned: false
      };

      ensureSnapshotBodyCloned(snapshot);

      expect(snapshot.body).toBeNull();
      expect(snapshot.is_body_cloned).toBe(false);
    });

    test('应该正确处理复杂嵌套对象的深度克隆', () => {
      const complexBody = {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello!' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              parameters: { type: 'object', properties: { location: { type: 'string' } } }
            }
          }
        ],
        metadata: { nested: { deep: { value: 123 } } }
      };

      const snapshot: RequestSnapshot = {
        method: 'POST',
        url: 'https://example.com',
        headers: {},
        body: complexBody,
        content_type: 'application/json',
        is_json_body: true,
        is_body_cloned: false
      };

      ensureSnapshotBodyCloned(snapshot);

      expect(snapshot.is_body_cloned).toBe(true);

      // 修改原对象的各层嵌套
      complexBody.messages[0].content = 'MODIFIED';
      complexBody.tools[0].function.name = 'MODIFIED';
      complexBody.metadata.nested.deep.value = 999;

      // 验证快照不受影响
      expect(snapshot.body.messages[0].content).toBe('You are helpful.');
      expect(snapshot.body.tools[0].function.name).toBe('get_weather');
      expect(snapshot.body.metadata.nested.deep.value).toBe(123);
    });
  });

  describe('延迟克隆场景测试', () => {
    test('模拟首次请求成功（无需克隆）', async () => {
      const req = new Request('https://example.com/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4' })
      });

      const snapshot = await createRequestSnapshot(req);

      // 首次请求直接使用，不需要克隆
      expect(snapshot.is_body_cloned).toBe(false);
      expect(snapshot.body.model).toBe('gpt-4');

      // 模拟请求成功，不调用 ensureSnapshotBodyCloned
      // 整个请求过程无需执行 structuredClone
    });

    test('模拟 failover 重试（需要克隆）', async () => {
      const req = new Request('https://example.com/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4' })
      });

      const snapshot = await createRequestSnapshot(req);

      // 模拟首次请求失败
      expect(snapshot.is_body_cloned).toBe(false);

      // 模拟 failover 重试前调用
      ensureSnapshotBodyCloned(snapshot);
      expect(snapshot.is_body_cloned).toBe(true);

      // 第二次、第三次重试不会重复克隆
      const bodyRef = snapshot.body;
      ensureSnapshotBodyCloned(snapshot);
      expect(snapshot.body).toBe(bodyRef); // 同一引用
    });
  });
});
