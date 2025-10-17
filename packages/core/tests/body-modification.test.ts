import { describe, test, expect, beforeEach } from 'bun:test';
import { applyBodyRules } from '../src/worker';
import type { ExpressionContext } from '../src/expression-engine';

// Type definitions for test bodies with dynamic fields
interface TestBody extends Record<string, any> {
  model?: string;
  messages?: any[];
  thinking?: any;
  max_tokens?: number;
  newField?: string;
  metadata?: { processed: boolean };
  field1?: string;
  field2?: string;
  stream?: boolean;
}

describe('Body Modification Tests - Deep Copy and Isolation', () => {
  let mockContext: ExpressionContext;
  let requestLog: any;

  beforeEach(() => {
    mockContext = {
      headers: {},
      body: {},
      url: { pathname: '/test', search: '', host: 'localhost', protocol: 'http:' },
      method: 'POST',
      env: {},
    };

    requestLog = { requestId: 'test-request' };
  });

  test('should not mutate original body when applying add rules', async () => {
    const originalBody: TestBody = {
      model: 'original-model',
      messages: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
    };

    const rules = {
      add: {
        newField: 'added-value',
      },
    };

    mockContext.body = originalBody;
    const result = await applyBodyRules(originalBody, rules, mockContext, requestLog) as TestBody;

    // Result should have the new field
    expect(result.newField).toBe('added-value');

    // Original body should NOT be mutated
    expect(originalBody.newField).toBeUndefined();
  });

  test('should not mutate thinking structure when applying body.add rules', async () => {
    const originalBody = {
      model: 'claude-sonnet-4-5-20250929',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'thinking',
              thinking: 'I need to analyze this carefully...',
            },
            {
              type: 'text',
              text: 'Hello',
            },
          ],
        },
      ],
    };

    const rules = {
      add: {
        model: 'override-model',
      },
    };

    mockContext.body = originalBody;
    const result = await applyBodyRules(originalBody, rules, mockContext, requestLog);

    // Verify thinking structure is preserved
    expect(result.messages[0].content[0].type).toBe('thinking');
    expect(result.messages[0].content[0].thinking).toBe('I need to analyze this carefully...');

    // Verify thinking is NOT nested (no thinking.thinking)
    expect(typeof result.messages[0].content[0].thinking).toBe('string');
    expect((result.messages[0].content[0].thinking as any).thinking).toBeUndefined();

    // Original body should not be mutated
    expect(originalBody.model).toBe('claude-sonnet-4-5-20250929');
  });

  test('should handle nested message content correctly', async () => {
    const originalBody: TestBody = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Let me think about this problem...',
            },
            {
              type: 'text',
              text: 'Here is my response',
            },
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'get_weather',
              input: { city: 'London' },
            },
          ],
        },
      ],
    };

    const rules = {
      add: {
        metadata: { processed: true },
      },
    };

    mockContext.body = originalBody;
    const result = await applyBodyRules(originalBody, rules, mockContext, requestLog) as TestBody;

    // Verify all content blocks are preserved
    expect(result.messages![0].content.length).toBe(3);
    expect(result.messages![0].content[0].type).toBe('thinking');
    expect(result.messages![0].content[0].thinking).toBe('Let me think about this problem...');
    expect(result.messages![0].content[1].type).toBe('text');
    expect(result.messages![0].content[2].type).toBe('tool_use');

    // Verify metadata was added
    expect(result.metadata?.processed).toBe(true);

    // Original should not be mutated
    expect(originalBody.metadata).toBeUndefined();
  });

  test('should handle multiple sequential rule applications without mutation', async () => {
    const originalBody: TestBody = {
      model: 'original',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'thinking',
              thinking: 'First thought',
            },
          ],
        },
      ],
    };

    // First rule application
    const rules1 = {
      add: {
        field1: 'value1',
      },
    };

    mockContext.body = originalBody;
    const result1 = await applyBodyRules(originalBody, rules1, mockContext, requestLog) as TestBody;

    // Second rule application on result1
    const rules2 = {
      add: {
        field2: 'value2',
      },
    };

    mockContext.body = result1;
    const result2 = await applyBodyRules(result1, rules2, mockContext, requestLog) as TestBody;

    // Verify both fields are present in result2
    expect(result2.field1).toBe('value1');
    expect(result2.field2).toBe('value2');

    // Verify thinking is still correct
    expect(result2.messages![0].content[0].thinking).toBe('First thought');
    expect(typeof result2.messages![0].content[0].thinking).toBe('string');

    // Verify result1 was not mutated by the second application
    expect(result1.field2).toBeUndefined();

    // Verify original was not mutated
    expect(originalBody.field1).toBeUndefined();
    expect(originalBody.field2).toBeUndefined();
  });

  test('should handle replace rules without mutating nested structures', async () => {
    const originalBody = {
      model: 'old-model',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'thinking',
              thinking: 'Complex reasoning here',
            },
            {
              type: 'text',
              text: 'User message',
            },
          ],
        },
      ],
    };

    const rules = {
      add: {
        model: 'placeholder',
      },
      replace: {
        model: 'new-model',
      },
    };

    mockContext.body = originalBody;
    const result = await applyBodyRules(originalBody, rules, mockContext, requestLog);

    // Verify model was replaced
    expect(result.model).toBe('new-model');

    // Verify messages structure is intact
    expect(result.messages[0].content[0].thinking).toBe('Complex reasoning here');
    expect(typeof result.messages[0].content[0].thinking).toBe('string');

    // Original should not be mutated
    expect(originalBody.model).toBe('old-model');
  });

  test('should handle Claude Code plan mode request with thinking', async () => {
    // Simulate a real Claude Code request in plan mode
    const originalBody = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8192,
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,
      },
      messages: [
        {
          role: 'user',
          content: 'Help me debug this code',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Let me analyze the code structure first...',
            },
            {
              type: 'text',
              text: 'I will help you debug this code.',
            },
          ],
        },
        {
          role: 'user',
          content: 'What is the issue?',
        },
      ],
    };

    // Simulate upstream body.add rule (like in your config)
    const rules = {
      add: {
        model: 'claude-sonnet-4-5-20250929',
      },
    };

    mockContext.body = originalBody;
    const result = await applyBodyRules(originalBody, rules, mockContext, requestLog);

    // Verify thinking structure is preserved
    expect(result.messages[1].content[0].type).toBe('thinking');
    expect(result.messages[1].content[0].thinking).toBe('Let me analyze the code structure first...');
    expect(typeof result.messages[1].content[0].thinking).toBe('string');

    // Verify thinking config at root level is preserved
    expect(result.thinking.type).toBe('enabled');
    expect(result.thinking.budget_tokens).toBe(10000);

    // Original should not be mutated
    expect(originalBody).toEqual({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8192,
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,
      },
      messages: [
        {
          role: 'user',
          content: 'Help me debug this code',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Let me analyze the code structure first...',
            },
            {
              type: 'text',
              text: 'I will help you debug this code.',
            },
          ],
        },
        {
          role: 'user',
          content: 'What is the issue?',
        },
      ],
    });
  });

  test('should handle array content with mixed types', async () => {
    const originalBody: TestBody = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this image' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: 'base64encodeddata',
              },
            },
            { type: 'thinking', thinking: 'Analyzing the image...' },
          ],
        },
      ],
    };

    const rules = {
      add: {
        stream: true,
      },
    };

    mockContext.body = originalBody;
    const result = await applyBodyRules(originalBody, rules, mockContext, requestLog) as TestBody;

    // Verify all content blocks are preserved with correct structure
    expect(result.messages![0].content.length).toBe(3);
    expect(result.messages![0].content[0].type).toBe('text');
    expect(result.messages![0].content[1].type).toBe('image');
    expect(result.messages![0].content[1].source.data).toBe('base64encodeddata');
    expect(result.messages![0].content[2].type).toBe('thinking');
    expect(result.messages![0].content[2].thinking).toBe('Analyzing the image...');

    // Original should not be mutated
    expect(originalBody.stream).toBeUndefined();
  });
});
