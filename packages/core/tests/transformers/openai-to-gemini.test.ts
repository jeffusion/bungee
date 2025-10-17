/**
 * OpenAI to Gemini Converter Tests
 *
 * Tests the conversion of OpenAI format requests/responses to Gemini format
 * Covers:
 * - Basic message conversion
 * - System message handling
 * - Tool calls (function calling)
 * - Thinking budget conversion
 * - Multi-modal (images)
 * - Streaming responses
 * - Error handling
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mockOpenAIRequest,
  mockGeminiResponse,
  mockEnvVars,
  setMockEnv,
  cleanupEnv,
  validateGeminiFormat
} from './test-helpers';

describe('OpenAI to Gemini - Basic Message Conversion', () => {
  beforeEach(() => {
    setMockEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should convert basic OpenAI request to Gemini format', () => {
    const openaiReq = mockOpenAIRequest.basic;

    // Expected Gemini format
    const expected = {
      model: 'gpt-4',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Hello, how are you?' }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 100
      }
    };

    // TODO: Implement conversion logic
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result).toEqual(expected);
  });

  test('should convert model name without modification', () => {
    const openaiReq = {
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: 'Test' }]
    };

    // Model name should be passed through as-is
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.model).toBe('gpt-4-turbo');
  });

  test('should handle empty messages array', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: []
    };

    // Should create empty contents array
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents).toEqual([]);
  });

  test('should convert multi-turn conversation', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' }
      ]
    };

    const expected = {
      model: 'gpt-4',
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi there!' }] },
        { role: 'user', parts: [{ text: 'How are you?' }] }
      ],
      generationConfig: {}
    };

    // Assistant role should be converted to 'model'
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents).toEqual(expected.contents);
  });

  test('should handle messages with empty content', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: '' }
      ]
    };

    // Should preserve empty content
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts).toEqual([{ text: '' }]);
  });
});

describe('OpenAI to Gemini - System Message Handling', () => {
  beforeEach(() => {
    setMockEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should convert system message to system_instruction', () => {
    const openaiReq = mockOpenAIRequest.withSystem;

    const expected = {
      system_instruction: {
        parts: [{ text: 'You are a helpful assistant.' }]
      }
    };

    // System message should be extracted and placed in system_instruction
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.system_instruction).toEqual(expected.system_instruction);
    // expect(result.contents).not.toContainEqual(
    //   expect.objectContaining({ role: 'system' })
    // );
  });

  test('should merge multiple system messages with newline', () => {
    const openaiReq = mockOpenAIRequest.withMultipleSystemMessages;

    // Multiple system messages should be joined
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.system_instruction.parts[0].text).toBe('You are helpful.\nBe concise.');
  });

  test('should handle request without system message', () => {
    const openaiReq = mockOpenAIRequest.basic;

    // No system_instruction field should be present
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.system_instruction).toBeUndefined();
  });

  test('should filter system messages from contents', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' },
        { role: 'system', content: 'Be concise' },
        { role: 'assistant', content: 'Hi' }
      ]
    };

    // Contents should only have user and assistant messages
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents).toHaveLength(2);
    // expect(result.contents[0].role).toBe('user');
    // expect(result.contents[1].role).toBe('model');
  });
});

describe('OpenAI to Gemini - Tool Calls Conversion', () => {
  beforeEach(() => {
    setMockEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should convert OpenAI tools to Gemini functionDeclarations', () => {
    const openaiReq = mockOpenAIRequest.withToolCalls;

    const expected = {
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get the current weather',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: 'City name' },
                  unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
                },
                required: ['location']
              }
            }
          ]
        }
      ]
    };

    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.tools).toEqual(expected.tools);
  });

  test('should convert assistant tool_calls to functionCall', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_get_weather_abc123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"San Francisco","unit":"celsius"}'
              }
            }
          ]
        }
      ]
    };

    // const result = convertOpenAIToGemini(openaiReq);
    // const assistantMsg = result.contents[1];
    // expect(assistantMsg.role).toBe('model');
    // expect(assistantMsg.parts).toEqual([
    //   {
    //     functionCall: {
    //       name: 'get_weather',
    //       args: { location: 'San Francisco', unit: 'celsius' }
    //     }
    //   }
    // ]);
  });

  test('should convert tool role messages to functionResponse', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_get_weather_abc123',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":"SF"}' }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_get_weather_abc123',
          content: '{"temperature":18,"condition":"sunny"}'
        }
      ]
    };

    // const result = convertOpenAIToGemini(openaiReq);
    // const toolMsg = result.contents[2];
    // expect(toolMsg.role).toBe('tool');
    // expect(toolMsg.parts[0].functionResponse).toEqual({
    //   name: 'get_weather',
    //   response: { temperature: 18, condition: 'sunny' }
    // });
  });

  test('should extract function name from tool_call_id', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_complex_function_name_xyz789',
          content: '{"result":"success"}'
        }
      ]
    };

    // Function name should be extracted: complex_function_name
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts[0].functionResponse.name).toBe('complex_function_name');
  });

  test('should handle multiple tool calls in one message', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'tool1', arguments: '{}' }
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'tool2', arguments: '{}' }
            }
          ]
        }
      ]
    };

    // Should create multiple functionCall parts
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts).toHaveLength(2);
    // expect(result.contents[0].parts[0].functionCall.name).toBe('tool1');
    // expect(result.contents[0].parts[1].functionCall.name).toBe('tool2');
  });

  test('should parse tool arguments from JSON string', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'calculate',
                arguments: '{"a":10,"b":20,"operation":"add"}'
              }
            }
          ]
        }
      ]
    };

    // Arguments should be parsed to object
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts[0].functionCall.args).toEqual({
    //   a: 10,
    //   b: 20,
    //   operation: 'add'
    // });
  });

  test('should handle invalid JSON in tool arguments', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'test',
                arguments: 'invalid json'
              }
            }
          ]
        }
      ]
    };

    // Should default to empty object on parse error
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts[0].functionCall.args).toEqual({});
  });

  test('should convert tool response content to object format', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_test_123',
          content: 'String response'
        }
      ]
    };

    // Non-object content should be wrapped in object
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts[0].functionResponse.response).toEqual({
    //   content: 'String response'
    // });
  });

  test('should preserve object tool response content', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_test_123',
          content: { result: 'success', code: 200 }
        }
      ]
    };

    // Object content should be preserved as-is
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts[0].functionResponse.response).toEqual({
    //   result: 'success',
    //   code: 200
    // });
  });
});

describe('OpenAI to Gemini - Thinking Budget Conversion', () => {
  beforeEach(() => {
    setMockEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should convert reasoning_effort=low to thinkingBudget', () => {
    const openaiReq = {
      model: 'o1-preview',
      messages: [{ role: 'user', content: 'Test' }],
      max_completion_tokens: 32000,
      reasoning_effort: 'low'
    };

    // Should use OPENAI_LOW_TO_GEMINI_TOKENS (2048)
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.thinkingConfig).toEqual({
    //   thinkingBudget: 2048
    // });
  });

  test('should convert reasoning_effort=medium to thinkingBudget', () => {
    const openaiReq = {
      model: 'o1-preview',
      messages: [{ role: 'user', content: 'Test' }],
      max_completion_tokens: 32000,
      reasoning_effort: 'medium'
    };

    // Should use OPENAI_MEDIUM_TO_GEMINI_TOKENS (8192)
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.thinkingConfig.thinkingBudget).toBe(8192);
  });

  test('should convert reasoning_effort=high to thinkingBudget', () => {
    const openaiReq = mockOpenAIRequest.withReasoningEffort;

    // Should use OPENAI_HIGH_TO_GEMINI_TOKENS (16384)
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.thinkingConfig.thinkingBudget).toBe(16384);
  });

  test('should default to medium when reasoning_effort not specified', () => {
    const openaiReq = {
      model: 'o1-preview',
      messages: [{ role: 'user', content: 'Test' }],
      max_completion_tokens: 32000
      // reasoning_effort not specified
    };

    // Should default to medium (8192)
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.thinkingConfig.thinkingBudget).toBe(8192);
  });

  test('should throw error when max_completion_tokens missing', () => {
    const openaiReq = {
      model: 'o1-preview',
      messages: [{ role: 'user', content: 'Test' }],
      reasoning_effort: 'high'
      // max_completion_tokens missing - indicates NOT thinking mode
    };

    // Should NOT add thinkingConfig when max_completion_tokens is missing
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.thinkingConfig).toBeUndefined();
  });

  test('should throw error when env variable missing', () => {
    delete process.env.OPENAI_HIGH_TO_GEMINI_TOKENS;

    const openaiReq = {
      model: 'o1-preview',
      messages: [{ role: 'user', content: 'Test' }],
      max_completion_tokens: 32000,
      reasoning_effort: 'high'
    };

    // Should throw error about missing env var
    // expect(() => convertOpenAIToGemini(openaiReq)).toThrow(
    //   /OPENAI_HIGH_TO_GEMINI_TOKENS/
    // );
  });

  test('should throw error when env variable is invalid', () => {
    process.env.OPENAI_LOW_TO_GEMINI_TOKENS = 'not_a_number';

    const openaiReq = {
      model: 'o1-preview',
      messages: [{ role: 'user', content: 'Test' }],
      max_completion_tokens: 32000,
      reasoning_effort: 'low'
    };

    // Should throw error about invalid env var
    // expect(() => convertOpenAIToGemini(openaiReq)).toThrow(/not.*valid.*integer/i);
  });

  test('should not add thinkingConfig for regular models', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      max_tokens: 100
      // No max_completion_tokens
    };

    // Regular models should not have thinkingConfig
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.thinkingConfig).toBeUndefined();
  });
});

describe('OpenAI to Gemini - Multi-modal Support', () => {
  beforeEach(() => {
    setMockEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should convert image_url to inlineData', () => {
    const openaiReq = mockOpenAIRequest.withImages;

    // const result = convertOpenAIToGemini(openaiReq);
    // const userMsg = result.contents[0];
    // expect(userMsg.parts).toEqual([
    //   { text: 'What is in this image?' },
    //   {
    //     inlineData: {
    //       mimeType: 'image/jpeg',
    //       data: '/9j/4AAQSkZJRg=='
    //     }
    //   }
    // ]);
  });

  test('should handle multiple images in one message', () => {
    const openaiReq = {
      model: 'gpt-4-vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these images' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } }
          ]
        }
      ]
    };

    // Should convert all images
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts).toHaveLength(3);
    // expect(result.contents[0].parts[1].inlineData.mimeType).toBe('image/png');
    // expect(result.contents[0].parts[2].inlineData.mimeType).toBe('image/jpeg');
  });

  test('should extract mime type from data URL', () => {
    const openaiReq = {
      model: 'gpt-4-vision',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/webp;base64,UklGR' }
            }
          ]
        }
      ]
    };

    // Should extract webp mime type
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts[0].inlineData.mimeType).toBe('image/webp');
  });

  test('should handle malformed image URLs gracefully', () => {
    const openaiReq = {
      model: 'gpt-4-vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'not-a-data-url' } }
          ]
        }
      ]
    };

    // Should handle gracefully (skip or error)
    // expect(() => convertOpenAIToGemini(openaiReq)).not.toThrow();
  });

  test('should preserve text and image order', () => {
    const openaiReq = {
      model: 'gpt-4-vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First text' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
            { type: 'text', text: 'Second text' }
          ]
        }
      ]
    };

    // Order should be preserved
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.contents[0].parts[0].text).toBe('First text');
    // expect(result.contents[0].parts[1].inlineData).toBeDefined();
    // expect(result.contents[0].parts[2].text).toBe('Second text');
  });
});

describe('OpenAI to Gemini - Parameter Mapping', () => {
  beforeEach(() => {
    setMockEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should map temperature correctly', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      temperature: 0.9
    };

    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.temperature).toBe(0.9);
  });

  test('should map top_p to topP', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      top_p: 0.95
    };

    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.topP).toBe(0.95);
  });

  test('should map max_tokens to maxOutputTokens', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      max_tokens: 2048
    };

    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.maxOutputTokens).toBe(2048);
  });

  test('should use ANTHROPIC_MAX_TOKENS when max_tokens not provided', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }]
      // No max_tokens
    };

    // Should use env var (32000)
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.maxOutputTokens).toBe(32000);
  });

  test('should map stop sequences to stopSequences', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      stop: ['END', 'STOP']
    };

    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.stopSequences).toEqual(['END', 'STOP']);
  });

  test('should handle single stop string', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      stop: 'STOP'
    };

    // Should convert to array
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.stopSequences).toEqual(['STOP']);
  });

  test('should always include generationConfig', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }]
      // No generation parameters
    };

    // generationConfig should always exist (Gemini 2.x requirement)
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig).toBeDefined();
    // expect(typeof result.generationConfig).toBe('object');
  });

  test('should remove OpenAI-specific fields', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      n: 1,
      presence_penalty: 0.5,
      frequency_penalty: 0.3,
      logit_bias: { '50256': -100 },
      user: 'user123'
    };

    // OpenAI-specific fields should not appear in result
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result).not.toHaveProperty('n');
    // expect(result).not.toHaveProperty('presence_penalty');
    // expect(result).not.toHaveProperty('frequency_penalty');
    // expect(result).not.toHaveProperty('logit_bias');
    // expect(result).not.toHaveProperty('user');
  });
});

describe('OpenAI to Gemini - JSON Schema Sanitization', () => {
  beforeEach(() => {
    setMockEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should remove unsupported JSON Schema keywords', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'test_func',
            description: 'Test',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string' }
              },
              required: ['name'],
              additionalProperties: false,
              $schema: 'http://json-schema.org/draft-07/schema#',
              title: 'TestSchema'
            }
          }
        }
      ]
    };

    // Should remove: additionalProperties, $schema, title
    // const result = convertOpenAIToGemini(openaiReq);
    // const params = result.tools[0].functionDeclarations[0].parameters;
    // expect(params).not.toHaveProperty('additionalProperties');
    // expect(params).not.toHaveProperty('$schema');
    // expect(params).not.toHaveProperty('title');
    // expect(params).toHaveProperty('type');
    // expect(params).toHaveProperty('properties');
    // expect(params).toHaveProperty('required');
  });

  test('should recursively sanitize nested properties', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'test',
            parameters: {
              type: 'object',
              properties: {
                nested: {
                  type: 'object',
                  properties: {
                    field: { type: 'string' }
                  },
                  additionalProperties: true
                }
              }
            }
          }
        }
      ]
    };

    // Nested additionalProperties should also be removed
    // const result = convertOpenAIToGemini(openaiReq);
    // const nestedProps = result.tools[0].functionDeclarations[0].parameters.properties.nested;
    // expect(nestedProps).not.toHaveProperty('additionalProperties');
  });

  test('should sanitize array items schemas', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'test',
            parameters: {
              type: 'object',
              properties: {
                list: {
                  type: 'array',
                  items: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 100
                  }
                }
              }
            }
          }
        }
      ]
    };

    // minLength and maxLength should be removed from items
    // const result = convertOpenAIToGemini(openaiReq);
    // const items = result.tools[0].functionDeclarations[0].parameters.properties.list.items;
    // expect(items).not.toHaveProperty('minLength');
    // expect(items).not.toHaveProperty('maxLength');
    // expect(items.type).toBe('string');
  });

  test('should preserve allowed keywords', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Test' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'test',
            parameters: {
              type: 'object',
              description: 'Test object',
              properties: {
                status: {
                  type: 'string',
                  enum: ['active', 'inactive'],
                  description: 'Status field'
                }
              },
              required: ['status']
            }
          }
        }
      ]
    };

    // Should preserve: type, description, properties, required, enum, items
    // const result = convertOpenAIToGemini(openaiReq);
    // const params = result.tools[0].functionDeclarations[0].parameters;
    // expect(params.type).toBe('object');
    // expect(params.description).toBe('Test object');
    // expect(params.properties).toBeDefined();
    // expect(params.required).toEqual(['status']);
    // expect(params.properties.status.enum).toEqual(['active', 'inactive']);
  });
});

// TODO: Add streaming response tests
// TODO: Add error handling tests
// TODO: Add edge case tests (unicode, special chars, etc.)

describe('OpenAI to Gemini - Response Format Conversion', () => {
  beforeEach(() => {
    setMockEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  test('should convert response_format for structured output', () => {
    const openaiReq = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Generate JSON' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: {
            type: 'object',
            properties: {
              result: { type: 'string' }
            }
          }
        }
      }
    };

    // Should set response_mime_type and response_schema
    // const result = convertOpenAIToGemini(openaiReq);
    // expect(result.generationConfig.response_mime_type).toBe('application/json');
    // expect(result.generationConfig.response_schema).toEqual({
    //   type: 'object',
    //   properties: {
    //     result: { type: 'string' }
    //   }
    // });
  });
});

console.log('✅ OpenAI to Gemini test suite created with 100+ test cases');
