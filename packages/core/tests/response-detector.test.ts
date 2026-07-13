import { test, expect, describe } from 'bun:test';
import {
  checkResponseForFailover,
  MAX_BODY_INSPECT,
  MAX_PEEK_BYTES,
} from '../src/worker/request/response-detector';

function makeNonStreamingResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeStreamingResponse(chunks: Uint8Array[], status = 200, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

describe('checkResponseForFailover — non-streaming', () => {
  test('1. body 含 keyword → hit=true, matchedKeyword', async () => {
    const response = makeNonStreamingResponse('{"error":"internalerror"}');
    const result = await checkResponseForFailover(response, ['internalerror']);
    expect(result.hit).toBe(true);
    expect(result.matchedKeyword).toBe('internalerror');
  });

  test('2. body 不含 keyword → hit=false, response 不变', async () => {
    const response = makeNonStreamingResponse('{"ok":true}');
    const result = await checkResponseForFailover(response, ['internalerror']);
    expect(result.hit).toBe(false);
    expect(result.response).toBe(response);
  });

  test('3. Content-Length > 1MB → 跳过检测 hit=false', async () => {
    const response = makeNonStreamingResponse('{}', 200, { 'content-length': String(MAX_BODY_INSPECT + 1) });
    const result = await checkResponseForFailover(response, ['x']);
    expect(result.hit).toBe(false);
  });

  test('4. 缺失 Content-Length 实际 body > 1MB → 增量读取触发 bytecap hit=false', async () => {
    const bigBody = 'x'.repeat(MAX_BODY_INSPECT + 1);
    const response = makeNonStreamingResponse(bigBody, 200, {});
    const result = await checkResponseForFailover(response, ['NOT_FOUND']);
    expect(result.hit).toBe(false);
  });
});

describe('checkResponseForFailover — streaming SSE', () => {
  test('5. 流式首 chunk 命中 → hit=true, matchedKeyword', async () => {
    const chunk1 = new TextEncoder().encode('event: error\ndata: {"error":"internalerror"}\n\n');
    const chunk2 = new TextEncoder().encode('event: done\ndata: {}\n\n');
    const response = makeStreamingResponse([chunk1, chunk2]);
    const result = await checkResponseForFailover(response, ['internalerror']);
    expect(result.hit).toBe(true);
    expect(result.matchedKeyword).toBe('internalerror');
  });

  test('6. 流式 peek 4KB 未命中 + 遇到 \\n\\n 边界提前退出 + rest 透传完整内容', async () => {
    const chunk1 = new TextEncoder().encode('event: msg\ndata: hello world\n\n');
    const chunk2 = new TextEncoder().encode('event: done\ndata: ok\n\n');
    const response = makeStreamingResponse([chunk1, chunk2]);
    const result = await checkResponseForFailover(response, ['NOT_FOUND']);
    expect(result.hit).toBe(false);
    expect(result.response).toBeDefined();
    expect(result.response).not.toBe(response);
    const text = await result.response!.text();
    expect(text).toBe('event: msg\ndata: hello world\n\nevent: done\ndata: ok\n\n');
  });

  test('7. 流式空 stream → hit=false', async () => {
    const response = makeStreamingResponse([]);
    const result = await checkResponseForFailover(response, ['NOT_FOUND']);
    expect(result.hit).toBe(false);
  });
});

describe('checkResponseForFailover — keyword list', () => {
  test('8. 空关键字列表 → hit=false 不消费 body', async () => {
    const response = makeNonStreamingResponse('{"error":"x"}', 200);
    const result = await checkResponseForFailover(response, []);
    expect(result.hit).toBe(false);
    expect(result.response).toBe(response);
  });

  test('9. 多关键字任一命中', async () => {
    const response = makeNonStreamingResponse('{"error":"rate_limited"}', 200);
    const result = await checkResponseForFailover(response, ['internalerror', 'rate_limited']);
    expect(result.hit).toBe(true);
    expect(result.matchedKeyword).toBe('rate_limited');
  });
});

describe('checkResponseForFailover — error/edge cases', () => {
  test('10. peek 阶段 reader.read() 抛异常 → detector 抛 Error', async () => {
    const errorStream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('network failure during peek');
      },
    });
    const response = new Response(errorStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    expect(checkResponseForFailover(response, ['x'])).rejects.toThrow(
      /Failed to peek streaming response/
    );
  });

  test('11. 流式 chunk 切片：8KB chunk + 4KB peek 上限，后 4KB 入 overflow，wrapped body 完整', async () => {
    const fullChunk = new Uint8Array(8 * 1024);
    for (let i = 0; i < fullChunk.length; i++) {
      fullChunk[i] = (i % 256);
    }
    const tailChunk = new TextEncoder().encode('\n\ntail');
    const response = makeStreamingResponse([fullChunk, tailChunk], 200, {});
    const result = await checkResponseForFailover(response, ['NOT_FOUND']);
    expect(result.hit).toBe(false);
    expect(result.response).toBeDefined();
    expect(result.response).not.toBe(response);
    const received = new Uint8Array(await result.response!.arrayBuffer());
    expect(received.length).toBe(fullChunk.length + tailChunk.length);
    expect(received).toEqual(concatBytes(fullChunk, tailChunk));
  });

  test('12. 非流式命中后 clone.body.locked 为 false（cancel + releaseLock）', async () => {
    const response = makeNonStreamingResponse('{"error":"internalerror"}', 200);
    const cloned = response.clone();
    await checkResponseForFailover(response, ['internalerror']);
    expect(cloned.body!.locked).toBe(false);
  });
});
