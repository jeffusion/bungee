/**
 * Test helpers for transformer testing
 * Contains mock data, utility functions, and common test scenarios
 */

// ==================== Mock Request Bodies ====================

export const mockOpenAIRequest = {
  basic: {
    model: 'gpt-4',
    messages: [
      { role: 'user', content: 'Hello, how are you?' }
    ],
    max_tokens: 100,
    temperature: 0.7
  },

  withSystem: {
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' }
    ],
    max_tokens: 100
  },

  withMultipleSystemMessages: {
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hi!' }
    ],
    max_tokens: 50
  },

  withToolCalls: {
    model: 'gpt-4',
    messages: [
      { role: 'user', content: 'What is the weather?' }
    ],
    tools: [
      {
        type: 'function',
        function: {
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
      }
    ],
    max_tokens: 100
  },

  withReasoningEffort: {
    model: 'o1-preview',
    messages: [
      { role: 'user', content: 'Solve this complex problem...' }
    ],
    max_completion_tokens: 32000,
    reasoning_effort: 'high'
  },

  withImages: {
    model: 'gpt-4-vision',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
            }
          }
        ]
      }
    ],
    max_tokens: 100
  }
};

export const mockAnthropicRequest = {
  basic: {
    model: 'claude-3-opus-20240229',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'Hello, world!' }
    ]
  },

  withSystem: {
    model: 'claude-3-sonnet-20240229',
    max_tokens: 1024,
    system: 'You are a helpful AI assistant.',
    messages: [
      { role: 'user', content: 'Hello!' }
    ]
  },

  withToolUse: {
    model: 'claude-3-opus-20240229',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'What is the weather?' }
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' }
          },
          required: ['location']
        }
      }
    ]
  },

  withThinking: {
    model: 'claude-3-opus-20240229',
    max_tokens: 4096,
    thinking: {
      type: 'enabled',
      budget_tokens: 8192
    },
    messages: [
      { role: 'user', content: 'Complex reasoning task...' }
    ]
  }
};

export const mockGeminiRequest = {
  basic: {
    model: 'gemini-2.0-flash',
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Hello!' }]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024
    }
  },

  withSystemInstruction: {
    model: 'gemini-2.0-flash',
    system_instruction: {
      parts: [{ text: 'You are a helpful assistant.' }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Hello!' }]
      }
    ],
    generationConfig: {}
  },

  withFunctionCall: {
    model: 'gemini-2.0-flash',
    contents: [
      {
        role: 'user',
        parts: [{ text: 'What is the weather?' }]
      }
    ],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get the current weather',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' }
              },
              required: ['location']
            }
          }
        ]
      }
    ],
    generationConfig: {}
  },

  withThinking: {
    model: 'gemini-2.0-flash-thinking',
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Complex problem...' }]
      }
    ],
    generationConfig: {
      thinkingConfig: {
        thinkingBudget: 8192
      }
    }
  }
};

// ==================== Mock Response Bodies ====================

export const mockOpenAIResponse = {
  basic: {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1677652288,
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'I am doing well, thank you!'
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30
    }
  },

  withToolCalls: {
    id: 'chatcmpl-456',
    object: 'chat.completion',
    created: 1677652288,
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: {
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
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: {
      prompt_tokens: 15,
      completion_tokens: 25,
      total_tokens: 40
    }
  }
};

export const mockAnthropicResponse = {
  basic: {
    id: 'msg_abc123',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'I am doing well, thank you!'
      }
    ],
    model: 'claude-3-opus-20240229',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 15,
      output_tokens: 25
    }
  },

  withToolUse: {
    id: 'msg_def456',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_123',
        name: 'get_weather',
        input: {
          location: 'San Francisco',
          unit: 'celsius'
        }
      }
    ],
    model: 'claude-3-opus-20240229',
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 20,
      output_tokens: 30
    }
  },

  withThinking: {
    id: 'msg_ghi789',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'Let me think about this...'
      },
      {
        type: 'text',
        text: 'The answer is 42.'
      }
    ],
    model: 'claude-3-opus-20240229',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 30,
      output_tokens: 50
    }
  }
};

export const mockGeminiResponse = {
  basic: {
    candidates: [
      {
        content: {
          parts: [
            { text: 'I am doing well, thank you!' }
          ],
          role: 'model'
        },
        finishReason: 'STOP'
      }
    ],
    usageMetadata: {
      promptTokenCount: 15,
      candidatesTokenCount: 25,
      totalTokenCount: 40
    }
  },

  withFunctionCall: {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: {
                  location: 'San Francisco',
                  unit: 'celsius'
                }
              }
            }
          ],
          role: 'model'
        },
        finishReason: 'STOP'
      }
    ],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 30,
      totalTokenCount: 50
    }
  },

  error: {
    error: {
      code: 404,
      message: 'The requested model was not found.',
      status: 'NOT_FOUND'
    }
  }
};

// ==================== Environment Variables ====================

export const mockEnvVars = {
  // Anthropic max_tokens
  ANTHROPIC_MAX_TOKENS: '32000',

  // OpenAI reasoning max_tokens
  OPENAI_REASONING_MAX_TOKENS: '32000',

  // OpenAI to Anthropic thinking budget mappings
  OPENAI_LOW_TO_ANTHROPIC_TOKENS: '2048',
  OPENAI_MEDIUM_TO_ANTHROPIC_TOKENS: '8192',
  OPENAI_HIGH_TO_ANTHROPIC_TOKENS: '16384',

  // OpenAI to Gemini thinking budget mappings
  OPENAI_LOW_TO_GEMINI_TOKENS: '2048',
  OPENAI_MEDIUM_TO_GEMINI_TOKENS: '8192',
  OPENAI_HIGH_TO_GEMINI_TOKENS: '16384',

  // Anthropic to OpenAI reasoning effort thresholds
  ANTHROPIC_TO_OPENAI_LOW_REASONING_THRESHOLD: '2048',
  ANTHROPIC_TO_OPENAI_HIGH_REASONING_THRESHOLD: '16384',

  // Gemini to OpenAI reasoning effort thresholds
  GEMINI_TO_OPENAI_LOW_REASONING_THRESHOLD: '2048',
  GEMINI_TO_OPENAI_HIGH_REASONING_THRESHOLD: '16384'
};

// ==================== Utility Functions ====================

/**
 * Set mock environment variables for testing
 */
export function setMockEnv() {
  Object.entries(mockEnvVars).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

/**
 * Clean up environment variables after testing
 */
export function cleanupEnv() {
  Object.keys(mockEnvVars).forEach(key => {
    delete process.env[key];
  });
}

/**
 * Create a mock fetch response
 */
export function createMockResponse(body: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}

/**
 * Create a mock streaming response
 */
export function createMockStreamResponse(chunks: string[]) {
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => {
        controller.enqueue(new TextEncoder().encode(chunk));
      });
      controller.close();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

/**
 * Parse SSE stream to events
 */
export async function parseSSEStream(response: Response): Promise<any[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];

  const decoder = new TextDecoder();
  let allData = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    allData += decoder.decode(value);
  }

  // Parse SSE events
  return allData
    .split('\n\n')
    .filter(line => line.startsWith('data: '))
    .map(line => {
      const dataContent = line.substring(6);
      if (dataContent === '[DONE]') return null;
      try {
        return JSON.parse(dataContent);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Validate OpenAI format response
 */
export function validateOpenAIFormat(data: any): boolean {
  return (
    typeof data === 'object' &&
    typeof data.id === 'string' &&
    data.object === 'chat.completion' &&
    typeof data.created === 'number' &&
    Array.isArray(data.choices) &&
    data.choices.length > 0 &&
    data.choices[0].message !== undefined
  );
}

/**
 * Validate Anthropic format response
 */
export function validateAnthropicFormat(data: any): boolean {
  return (
    typeof data === 'object' &&
    data.type === 'message' &&
    data.role === 'assistant' &&
    Array.isArray(data.content) &&
    typeof data.model === 'string' &&
    typeof data.stop_reason === 'string'
  );
}

/**
 * Validate Gemini format response
 */
export function validateGeminiFormat(data: any): boolean {
  return (
    typeof data === 'object' &&
    Array.isArray(data.candidates) &&
    data.candidates.length > 0 &&
    data.candidates[0].content !== undefined
  );
}
