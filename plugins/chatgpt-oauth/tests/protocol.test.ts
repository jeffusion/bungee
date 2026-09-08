// Deterministic Codex SSE fixtures only: this is not a live upstream validation.
import { describe, expect, test } from 'bun:test';
import {
  CodexProtocolError,
  chatCompletionToResponses,
  consumeCodexResponse,
  convertChatCompletionsRequestToCodex,
  convertCodexSSEToChatCompletion,
  convertCodexSSEToChatCompletions,
  convertCodexSSEToResponses,
  convertResponsesRequestToChatCompletions,
  normalizeCodexResponsesRequest,
  parseCodexSSE,
  streamIncludesUsage
} from '../server/codex-protocol';
import { CodexModelCatalog } from '../server/codex-models';

const stream = [
  'event: response.created\r\ndata: {"type":"response.created","response":{"id":"resp_1","created_at":1700000000,"model":"gpt-codex"}}\r\n\r\n',
  'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":""}}\n\n',
  'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"q\\":1}"}\n\n',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":1}"}}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-codex","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]},{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":1}"}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
  'data: [DONE]\n\n'
].join('');

describe('Codex Responses protocol', () => {
  test('Chat Completions request maps multimodal input, tools and tool result', () => {
    const output = convertChatCompletionsRequestToCodex({
      model: 'gpt-codex',
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' }
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
    });
    expect(output.stream).toBe(true);
    expect(output.store).toBe(false);
    expect(output.input[0].role).toBe('developer');
    expect(output.input[1].content[1].type).toBe('input_image');
    expect(output.input[2].type).toBe('function_call');
    expect(output.input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: 'done' });
    expect(output.tools[0]).toMatchObject({ type: 'function', name: 'lookup', strict: false });
  });

  test('normalizer enforces Codex request invariants and strips unsupported fields', () => {
    const output = normalizeCodexResponsesRequest({ input: 'hello', stream: false, store: true, temperature: 0.5, user: 'x', tools: [{ type: 'web_search_preview_2025_03_11' }] });
    expect(output).toMatchObject({ stream: true, store: false, parallel_tool_calls: true });
    expect(output.input[0].content[0]).toEqual({ type: 'input_text', text: 'hello' });
    expect(output.tools[0].type).toBe('web_search');
    expect(output.temperature).toBeUndefined();
  });

  test('stream and nonstream use the same processor and preserve output_item.done', async () => {
    const chunks: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(stream)) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.includes('hello'))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('"tool_calls"'))).toBe(true);
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n');
    const completion = await convertCodexSSEToChatCompletion(stream);
    expect(completion.choices[0].message.content).toBe('hello');
    expect(completion.choices[0].message.tool_calls[0].function.name).toBe('lookup');
    expect(completion.usage.total_tokens).toBe(5);
  });

  test('image partial and done events are converted without duplicate final image', async () => {
    const source = [
      'data: {"type":"response.image_generation_call.partial_image","item_id":"img_1","output_format":"png","partial_image_b64":"AA=="}\n\n',
      'data: {"type":"response.output_item.done","item":{"id":"img_1","type":"image_generation_call","output_format":"png","result":"AA=="}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"img_1","type":"image_generation_call","output_format":"png","result":"AA=="}]}}\n\n'
    ].join('');
    const chunks: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source)) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.includes('data:image/png;base64,AA=='))).toHaveLength(1);
    expect((await convertCodexSSEToChatCompletion(source)).choices[0].message.images[0].image_url.url).toBe('data:image/png;base64,AA==');
  });

  test('incomplete and failed responses are explicit', async () => {
    const incomplete = await consumeCodexResponse('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}\n\n');
    expect(incomplete.terminal).toBe('incomplete');
    await expect(consumeCodexResponse('data: {"type":"response.failed","response":{"status":"failed"}}\n\n')).rejects.toMatchObject({ kind: 'failed' });
    await expect(consumeCodexResponse('data: {"type":"response.output_text.delta","delta":"x"}\n\n')).rejects.toMatchObject({ kind: 'unexpected_eof' });
  });

  test('SSE parser has bounded event/body and cancellation', async () => {
    await expect(consumeCodexResponse('data: {"type":"response.output_text.delta","delta":"x"}\n\n', { maxEventBytes: 4 })).rejects.toMatchObject({ kind: 'body_limit' });
    const controller = new AbortController();
    controller.abort();
    await expect(consumeCodexResponse(stream, { signal: controller.signal })).rejects.toBeInstanceOf(CodexProtocolError);
  });

  test('Chat Completion response has a Responses representation', () => {
    const output = chatCompletionToResponses({ id: 'c', model: 'gpt-codex', created: 1, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok', tool_calls: [{ id: 'call', function: { name: 'x', arguments: '{}' } }] } }] });
    expect(output.output).toHaveLength(2);
    expect(output.output[1]).toMatchObject({ type: 'function_call', call_id: 'call', name: 'x' });
  });

  test('model catalog only returns source-backed metadata', async () => {
    const catalog = new CodexModelCatalog({
      kind: 'upstream',
      sourceRef: 'fixture://codex-models',
      load: async () => [{ id: 'fixture-model', source: 'static', sourceRef: 'wrong' }]
    });
    await expect(catalog.list()).resolves.toEqual([{ id: 'fixture-model', source: 'upstream', sourceRef: 'fixture://codex-models' }]);
  });

  test('message output_item.done is keyed and does not repeat output_text.delta', async () => {
    const source = [
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hello"}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"hello"}]}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    const chunks: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source)) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.includes('"content":"hello"'))).toHaveLength(1);
    expect((await convertCodexSSEToChatCompletion(source)).choices[0].message.content).toBe('hello');
  });

  test('output items are idempotently merged and ordered by output_index', async () => {
    const source = [
      'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"b","type":"function_call","call_id":"call_b","name":"b","arguments":"{}"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"b","type":"function_call","call_id":"call_b","name":"b","arguments":"{}"}}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"a","type":"function_call","call_id":"call_a","name":"a","arguments":"{}"}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"a","type":"function_call","call_id":"call_a","name":"a","arguments":"{}"},{"id":"b","type":"function_call","call_id":"call_b","name":"b","arguments":"{}"}]}}\n\n'
    ].join('');
    const result = await consumeCodexResponse(source);
    expect(result.output.map((item) => item.call_id)).toEqual(['call_a', 'call_b']);
    expect(result.output).toHaveLength(2);
  });

  test('usage maps in both directions and stream_options.include_usage is explicit', async () => {
    const source = 'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18,"input_tokens_details":{"cached_tokens":3,"cache_write_tokens":2},"output_tokens_details":{"reasoning_tokens":4}}}}\n\n';
    const streamed: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source, { includeUsage: true, request: { stream_options: { include_usage: true } } })) streamed.push(chunk);
    const usageChunk = streamed.find((chunk) => chunk.startsWith('data: {') && JSON.parse(chunk.slice(6)).usage);
    const usage = JSON.parse(usageChunk!.slice(6)).usage;
    expect(usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2, cached_creation_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 4 } });
    expect(JSON.parse(usageChunk!.slice(6)).choices).toEqual([]);
    expect(streamed.at(-1)).toBe('data: [DONE]\n\n');
    expect(streamed.filter((chunk) => chunk.startsWith('data: {')).every((chunk) => JSON.parse(chunk.slice(6)).usage === undefined || JSON.parse(chunk.slice(6)).choices.length === 0)).toBe(true);
    const requestWithoutUsage: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source, { request: {} })) requestWithoutUsage.push(chunk);
    expect(requestWithoutUsage.filter((chunk) => chunk.startsWith('data: {')).some((chunk) => JSON.parse(chunk.slice(6)).usage !== undefined)).toBe(false);
    const defaultOptions: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source)) defaultOptions.push(chunk);
    expect(defaultOptions.filter((chunk) => chunk.startsWith('data: {')).some((chunk) => JSON.parse(chunk.slice(6)).usage !== undefined)).toBe(false);
    const requestFlagOnly: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source, { request: { stream_options: { include_usage: true } } })) requestFlagOnly.push(chunk);
    const requestUsageChunk = requestFlagOnly.find((chunk) => chunk.startsWith('data: {') && JSON.parse(chunk.slice(6)).usage);
    expect(JSON.parse(requestUsageChunk!.slice(6)).choices).toEqual([]);
    const explicitFalse: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source, { includeUsage: false, request: { stream_options: { include_usage: true } } })) explicitFalse.push(chunk);
    expect(explicitFalse.filter((chunk) => chunk.startsWith('data: {')).some((chunk) => JSON.parse(chunk.slice(6)).usage !== undefined)).toBe(false);
    const omitted: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source, { includeUsage: false })) omitted.push(chunk);
    expect(JSON.parse(omitted[0].slice(6)).usage).toBeUndefined();
    expect(streamIncludesUsage({ stream_options: { include_usage: true } })).toBe(true);
    expect(chatCompletionToResponses({ choices: [{ finish_reason: 'stop', message: {} }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 4 } } }).usage).toEqual({ input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 4 } });
  });

  test('SSE handles byte-split UTF-8, CRLF split across chunks, multi-data and pending line limits', async () => {
    const text = '你🙂';
    const payload = `data: {"type":"response.output_text.delta","delta":"${text}"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\r\n\r\n`;
    const bytes = new TextEncoder().encode(payload);
    const source = new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); }
    });
    const result = await consumeCodexResponse(source);
    expect(result.response.status).toBe('completed');
    const parsed: string[] = [];
    const multi = 'data: {"type":"response.output_text.delta",\n' + 'data: "delta":"ok"}\n\n' + 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
    for await (const event of parseCodexSSE(multi)) parsed.push(event.type ?? '');
    expect(parsed).toEqual(['response.output_text.delta', 'response.completed']);
    await expect(consumeCodexResponse('data: ' + 'x'.repeat(20), { maxEventBytes: 8 })).rejects.toMatchObject({ kind: 'body_limit' });
  });

  test('ReadableStream early stop cancels and rejected cancel is contained', async () => {
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{}}\n\n')); },
      cancel() { cancelled++; return new Promise<never>(() => undefined); }
    });
    const iterator = parseCodexSSE(source)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);
    expect(cancelled).toBe(1);
  });

  test('blocking async source is interrupted by AbortSignal and calls return', async () => {
    let returned = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => { returned = true; return new Promise<never>(() => undefined); }
        };
      }
    };
    const controller = new AbortController();
    const pending = consumeCodexResponse(source, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await Promise.race([
      pending.then(() => new Error('unexpected success'), (error) => error),
      new Promise((resolve) => setTimeout(() => resolve(new Error('cancellation hung')), 100))
    ]);
    expect(result).toMatchObject({ kind: 'cancelled' });
    expect(returned).toBe(true);
  });

  test('parse/body-limit errors do not await a never-settling stream cancel', async () => {
    const makeSource = (payload: string) => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(payload)); },
      cancel() { return new Promise<never>(() => undefined); }
    });
    for (const [payload, kind, maxEventBytes] of [
      ['data: not-json\n\n', 'invalid_sse', 512],
      ['data: xxxxxxxxxx', 'body_limit', 4]
    ] as const) {
      const result = await Promise.race([
        consumeCodexResponse(makeSource(payload), { maxEventBytes }).then(() => new Error('unexpected success'), (error) => error),
        new Promise((resolve) => setTimeout(() => resolve(new Error('cleanup hung')), 100))
      ]);
      expect(result).toMatchObject({ kind });
    }
  });

  test('terminal locking, controlled error, [DONE] and unknown incomplete reason', async () => {
    const terminalThenDelta = [
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"late"}\n\n'
    ].join('');
    const chunks: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(terminalThenDelta)) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.includes('finish_reason'))).toHaveLength(1);
    await expect(consumeCodexResponse('data: {"type":"error","error":{"code":"bad_request"}}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n')).rejects.toMatchObject({ kind: 'failed' });
    await expect(consumeCodexResponse('data: [DONE]\n\n')).rejects.toMatchObject({ kind: 'incomplete' });
    await expect(consumeCodexResponse('data: [DONE]\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n')).rejects.toMatchObject({ kind: 'incomplete' });
    await expect(convertCodexSSEToChatCompletion('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"server_restart"},"output":[]}}\n\n')).rejects.toMatchObject({ kind: 'incomplete' });
    const filtered = await convertCodexSSEToChatCompletion('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[]}}\n\n');
    expect(filtered.choices[0].finish_reason).toBe('content_filter');
  });

  test('Responses shorthand system content, multimodal tool output and explicit response format policy', () => {
    const chat = convertResponsesRequestToChatCompletions({ input: [{ role: 'system', content: 'rules' }, { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'x', file_id: 'f', detail: 'high' }, { type: 'input_file', file_id: 'doc' }] }] });
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'rules' });
    expect(chat.messages[1].content).toEqual([{ type: 'image_url', image_url: { url: 'x', file_id: 'f', detail: 'high' } }, { type: 'file', file: { file_id: 'doc' } }]);
    expect(convertChatCompletionsRequestToCodex({ messages: [{ role: 'user', content: [{ type: 'future_part', value: 1 }] }] }).input[0].content[0].text).toContain('future_part');
    const request = convertChatCompletionsRequestToCodex({ messages: [{ role: 'user', content: 'x' }], response_format: { type: 'text' } });
    expect(request.text.format).toEqual({ type: 'text' });
    expect(() => convertChatCompletionsRequestToCodex({ messages: [], response_format: { type: 'json_object' } })).toThrow(/json_object/);
    expect(() => convertChatCompletionsRequestToCodex({ messages: [], tools: [{ type: 'function', function: { name: 'x'.repeat(65) } }] })).toThrow(/tool names/);
  });

  test('tool history requires unambiguous results and makes every missing id unique', () => {
    const output = convertChatCompletionsRequestToCodex({ messages: [
      { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'a', arguments: '{}' } }] },
      { role: 'tool', content: 'a' },
      { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'b', arguments: '{}' } }] },
      { role: 'tool', content: 'b' }
    ] });
    const ids = output.input.filter((item: any) => item.type === 'function_call').map((item: any) => item.call_id);
    expect(new Set(ids).size).toBe(2);
    expect(() => convertChatCompletionsRequestToCodex({ messages: [{ role: 'tool', tool_call_id: 'unknown', content: 'x' }] })).toThrow(/no matching/);
  });

  test('output identity never merges distinct messages by equal or prefix text', async () => {
    const items = [
      ['m1', 0, 'a'], ['m2', 1, 'a'], ['m3', 2, 'a'], ['m4', 3, 'ab']
    ];
    const source = items.flatMap(([id, index, text]) => [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: id, output_index: index, delta: text })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: index, item: { id, type: 'message', content: [{ type: 'output_text', text }] } })}\n\n`
    ]).concat('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n').join('');
    const result = await consumeCodexResponse(source);
    expect(result.output.filter((item) => item.type === 'message').map((item) => item.content[0].text)).toEqual(['a', 'a', 'a', 'ab']);
    const chunks: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source)) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.includes('"content":"a"') || chunk.includes('"content":"ab"'))).toHaveLength(4);
  });

  test('content_index is scoped to its message owner', async () => {
    const makeSource = (texts: readonly string[]) => texts.flatMap((text, index) => [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: `m${index}`, output_index: index, content_index: 0, delta: text })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: index, content_index: 0, item: { id: `m${index}`, type: 'message', content: [{ type: 'output_text', text }] } })}\n\n`
    ]).concat('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n').join('');
    for (const [texts, expected] of [[[ 'a', 'a' ], 'aa'], [['a', 'ab'], 'aab']] as const) {
      const source = makeSource(texts);
      const completion = await convertCodexSSEToChatCompletion(source);
      expect(completion.choices[0].message.content).toBe(expected);
      const chunks: string[] = [];
      for await (const chunk of convertCodexSSEToChatCompletions(source)) chunks.push(chunk);
      expect(chunks.filter((chunk) => chunk.startsWith('data: {') && JSON.parse(chunk.slice(6)).choices[0]?.delta?.content).map((chunk) => JSON.parse(chunk.slice(6)).choices[0].delta.content)).toEqual(Array.from(texts));
    }
  });

  test('one message can track multiple content blocks independently', async () => {
    const source = [
      'data: {"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"a"}\n\n',
      'data: {"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":1,"delta":"b"}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"m","type":"message","content":[{"type":"output_text","text":"ab"}]}}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"m","type":"message","content":[{"type":"output_text","text":"ab"}]}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"m","type":"message","content":[{"type":"output_text","text":"a"},{"type":"output_text","text":"b"}]}]}}\n\n'
    ].join('');
    const chunks: string[] = [];
    for await (const chunk of convertCodexSSEToChatCompletions(source)) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.startsWith('data: {') && JSON.parse(chunk.slice(6)).choices[0]?.delta?.content).map((chunk) => JSON.parse(chunk.slice(6)).choices[0].delta.content)).toEqual(['a', 'b']);
    expect((await convertCodexSSEToChatCompletion(source)).choices[0].message.content).toBe('ab');
  });

  test('tool output keeps ordinary JSON strings and converts only supported multimodal arrays', () => {
    const output = convertChatCompletionsRequestToCodex({ messages: [
      { role: 'assistant', tool_calls: [
        { id: 'json-array', type: 'function', function: { name: 'json_array', arguments: '{}' } },
        { id: 'json-strings', type: 'function', function: { name: 'json_strings', arguments: '{}' } },
        { id: 'json-object', type: 'function', function: { name: 'json_object', arguments: '{}' } },
        { id: 'image', type: 'function', function: { name: 'image', arguments: '{}' } }
      ] },
      { role: 'tool', tool_call_id: 'json-array', content: '[1,2]' },
      { role: 'tool', tool_call_id: 'json-strings', content: '["a","b"]' },
      { role: 'tool', tool_call_id: 'json-object', content: '[{"x":1}]' },
      { role: 'tool', tool_call_id: 'image', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }
    ] });
    const values = output.input.filter((item: any) => item.type === 'function_call_output');
    expect(values.slice(0, 3).map((item: any) => item.output)).toEqual(['[1,2]', '["a","b"]', '[{"x":1}]']);
    expect(values[3].output).toEqual([{ type: 'input_image', image_url: 'data:image/png;base64,x' }]);
    expect(values[3].output.every((part: any) => part !== undefined && part !== null)).toBe(true);
  });

  test('normalizer converts shorthand system input', () => {
    expect(normalizeCodexResponsesRequest({ input: [{ role: 'system', content: 'rules' }] }).input[0].role).toBe('developer');
  });

  test('Responses text json_schema format maps to Chat response_format', () => {
    expect(convertResponsesRequestToChatCompletions({ text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } } }).response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true } });
  });

  test('Chat Completion terminal status maps explicitly', () => {
    for (const [finish_reason, reason] of [['length', 'max_output_tokens'], ['content_filter', 'content_filter']] as const) {
      expect(chatCompletionToResponses({ choices: [{ finish_reason, message: { role: 'assistant', content: 'x' } }] })).toMatchObject({ status: 'incomplete', incomplete_details: { reason } });
    }
    for (const finish_reason of ['stop', 'tool_calls'] as const) {
      expect(chatCompletionToResponses({ choices: [{ finish_reason, message: { role: 'assistant', content: 'x' } }] }).status).toBe('completed');
    }
    expect(() => chatCompletionToResponses({ choices: [{ finish_reason: 'weird', message: { role: 'assistant', content: 'x' } }] })).toThrow(/finish_reason/);
  });

  test('tool pending state rejects late results and preserves explicit call_missing ids', () => {
    expect(() => convertChatCompletionsRequestToCodex({ messages: [
      { role: 'assistant', tool_calls: [{ id: 'call_late', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'user', content: 'new turn' },
      { role: 'tool', tool_call_id: 'call_late', content: 'late' }
    ] })).toThrow(/pending|unresolved|matching/);
    const output = convertChatCompletionsRequestToCodex({ messages: [
      { role: 'assistant', tool_calls: [
        { id: 'call_missing_0', type: 'function', function: { name: 'explicit', arguments: '{}' } },
        { type: 'function', function: { name: 'generated', arguments: '{}' } }
      ] },
      { role: 'tool', tool_call_id: 'call_missing_0', content: 'one' },
      { role: 'tool', tool_call_id: 'call_missing_1', content: 'two' }
    ] });
    expect(output.input.filter((item: any) => item.type === 'function_call').map((item: any) => item.call_id)).toEqual(['call_missing_0', 'call_missing_1']);
    expect(() => convertChatCompletionsRequestToCodex({ messages: [{ role: 'assistant', tool_calls: [
      { id: 'duplicate', type: 'function', function: { name: 'a', arguments: '{}' } },
      { id: 'duplicate', type: 'function', function: { name: 'b', arguments: '{}' } }
    ] }] })).toThrow(/duplicate/);
  });

  test('heartbeat comments do not consume event limit and blank events reset state', async () => {
    const events: unknown[] = [];
    for await (const event of parseCodexSSE(': hi\n\n'.repeat(5) + 'id:x\n\n', { maxEventBytes: 8, maxTotalBytes: 1024 })) events.push(event);
    expect(events).toEqual([]);
  });

  test('all unsupported request and output shapes fail instead of being dropped', async () => {
    const longName = 'x'.repeat(65);
    expect(() => convertChatCompletionsRequestToCodex({ tools: [{ type: 'custom', name: longName }] })).toThrow(/tool names/);
    expect(() => convertChatCompletionsRequestToCodex({ tool_choice: { type: 'function', function: { name: longName } } })).toThrow(/tool names/);
    expect(() => convertChatCompletionsRequestToCodex({ tool_choice: { type: 'custom', custom: { name: longName } } })).toThrow(/tool names/);
    expect(() => normalizeCodexResponsesRequest({ tools: [{ type: 'function', name: longName }] })).toThrow(/tool names/);
    expect(() => normalizeCodexResponsesRequest({ tools: [{ type: 'custom', custom: { name: longName } }] })).toThrow(/tool names/);
    expect(() => chatCompletionToResponses({ choices: [{ finish_reason: 'stop', message: { tool_calls: [{ type: 'custom', custom: { name: longName } }] } }] })).toThrow(/tool names/);
    expect(() => convertResponsesRequestToChatCompletions({ input: [{ type: 'future_item' }] })).toThrow(/input item/);
    expect(() => convertResponsesRequestToChatCompletions({ tool_choice: { type: 'future_tool_choice' } })).toThrow(/tool_choice/);
    const unknownOutput = 'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"future_output"}]}}\n\n';
    await expect(consumeCodexResponse(unknownOutput)).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect(convertCodexSSEToChatCompletion(unknownOutput)).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect((async () => { for await (const _chunk of convertCodexSSEToChatCompletions(unknownOutput)) { /* consume until controlled termination */ } })()).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect((async () => { for await (const _chunk of convertCodexSSEToChatCompletions('data: {"type":"response.output_text.delta","delta":"x"}\n\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"server_restart"},"output":[]}}\n\n')) { /* consume until controlled termination */ } })()).rejects.toMatchObject({ kind: 'incomplete' });
  });

  test('native Responses output keeps web_search_call while Chat conversion rejects it', async () => {
    const source = 'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"web_search_call","id":"ws_1","status":"completed"}]}}\n\n';
    await expect(convertCodexSSEToResponses(source)).resolves.toMatchObject({ output: [{ type: 'web_search_call', id: 'ws_1' }] });
    await expect(convertCodexSSEToChatCompletion(source)).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
