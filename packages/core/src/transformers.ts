import type { TransformerConfig } from '@jeffusion/bungee-shared';

export const transformers: Record<string, TransformerConfig[]> = {
  'openai-to-anthropic': [
    {
      path: {
        action: 'replace',
        match: '^/v1/chat/completions$',
        replace: '/v1/messages',
      },
      request: {
        body: {
          add: {
            system: '{{ body.messages.filter(m => m.role === "system").map(m => m.content).join("\\n") || undefined }}',
            messages: '{{ body.messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content })) }}',
          },
          remove: ['stop', 'n', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'user'],
        },
      },
      response: [
        {
          match: { status: "^2..$" },
          rules: {
            default: {
              body: {
                add: {
                  id: '{{ "chatcmpl-" + body.id.replace("msg_", "") }}',
                  object: 'chat.completion',
                  created: '{{ Math.floor(Date.now() / 1000) }}',
                  model: '{{ body.model }}',
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: 'assistant',
                        content: '{{ body.content.map(c => c.text).join("") }}',
                      },
                      finish_reason: '{{ body.stop_reason === "end_turn" ? "stop" : (body.stop_reason === "max_tokens" ? "length" : body.stop_reason) }}',
                    },
                  ],
                  usage: {
                    prompt_tokens: '{{ body.usage.input_tokens }}',
                    completion_tokens: '{{ body.usage.output_tokens }}',
                    total_tokens: '{{ body.usage.input_tokens + body.usage.output_tokens }}',
                  },
                },
                remove: ['type', 'role', 'content', 'stop_reason', 'stop_sequence'],
              },
            },
            stream: {
              start: {
                body: {
                  add: {
                    id: '{{ "chatcmpl-" + (body.message && body.message.id ? body.message.id.replace("msg_", "") : crypto.randomUUID()) }}',
                    object: 'chat.completion.chunk',
                    created: '{{ Math.floor(Date.now() / 1000) }}',
                    model: '{{ body.message && body.message.model || "claude" }}',
                    choices: [
                      {
                        index: 0,
                        delta: { role: 'assistant', content: '' },
                        finish_reason: null,
                      },
                    ],
                  },
                  remove: ['type', 'message'],
                },
              },
              chunk: {
                body: {
                  add: {
                    id: '{{ "chatcmpl-" + crypto.randomUUID() }}',
                    object: 'chat.completion.chunk',
                    created: '{{ Math.floor(Date.now() / 1000) }}',
                    model: 'claude',
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: '{{ body.delta && body.delta.text || "" }}',
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  remove: ['type', 'index', 'delta', 'content_block'],
                },
              },
              end: {
                body: {
                  add: {
                    id: '{{ "chatcmpl-" + crypto.randomUUID() }}',
                    object: 'chat.completion.chunk',
                    created: '{{ Math.floor(Date.now() / 1000) }}',
                    model: 'claude',
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: '{{ body.delta && body.delta.stop_reason === "end_turn" ? "stop" : (body.delta && body.delta.stop_reason === "max_tokens" ? "length" : "stop") }}',
                      },
                    ],
                  },
                  remove: ['type', 'delta', 'usage'],
                },
              },
            },
          },
        },
      ],
    },
  ],
  'anthropic-to-openai': [
    {
      path: {
        action: 'replace',
        match: '^/v1/messages$',
        replace: '/v1/chat/completions',
      },
      request: {
        body: {
          add: {
            max_tokens: '{{body.max_tokens_to_sample}}',
          },
          remove: ['max_tokens_to_sample', 'stop_sequences'],
        },
      },
      response: [
        {
          match: { status: "^2..$" },
          rules: {
            default: {
              body: {
                add: {
                  content: [
                    {
                      type: 'text',
                      text: '{{body.choices[0].message.content}}',
                    },
                  ],
                  stop_reason: '{{body.choices[0].finish_reason}}',
                  usage: {
                    input_tokens: '{{body.usage.prompt_tokens}}',
                    output_tokens: '{{body.usage.completion_tokens}}',
                  },
                },
                remove: ['choices', 'id', 'created', 'model', 'object', 'system_fingerprint'],
              },
            },
            stream: {
              body: {
                remove: ['id', 'object', 'created', 'model', 'system_fingerprint', 'choices'],
                add: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: {
                    type: 'text_delta',
                    text: "{{ body.choices[0].delta.content || '' }}",
                  },
                },
              },
            },
          }
        }
      ],
    },
  ],
  'anthropic-to-gemini': [
    {
      path: {
        action: 'replace',
        match: '^/v1/messages$',
        replace:
          "{{ body.stream ? `/v1beta/models/${body.model}:streamGenerateContent?alt=sse` : `/v1beta/models/${body.model}:generateContent` }}",
      },
      request: {
        body: {
          add: {
            contents:
              '{{ body.messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: typeof m.content === "string" ? [{ text: m.content }] : m.content.filter(c => c.type === "text").map(c => ({ text: c.text })) })) }}',
            generationConfig: {
              temperature: '{{body.temperature || 0.7}}',
              maxOutputTokens: '{{body.max_tokens_to_sample || 2048}}',
              topP: '{{body.top_p || 1}}',
              topK: '{{body.top_k}}',
              stopSequences: '{{body.stop_sequences}}',
              thinkingConfig: '{{ body.thinking && body.thinking.type === "enabled" ? { includeThoughts: true, thinkingBudget: body.thinking.budget_tokens || -1 } : undefined }}',
            },
            tools: '{{ body.tools ? [{ functionDeclarations: body.tools.map(t => ({ name: t.name, description: t.description, parameters: deepClean(t.input_schema, ["$schema", "additionalProperties", "title"]) })) }] : undefined }}',
            toolConfig: '{{ body.tool_choice ? { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [body.tool_choice.name] } } : (body.tools ? { functionCallingConfig: { mode: "AUTO" } } : undefined) }}',
          },
          remove: [
            'model',
            'messages',
            'max_tokens_to_sample',
            'stop_sequences',
            'system',
            'stream',
            'max_tokens',
            'temperature',
            'top_p',
            'top_k',
            'metadata',
            'tool_choice',
            'thinking',
            'tools',
          ],
        },
      },
      response: [
        {
          match: { status: "^2..$" },
          rules: {
            default: {
              body: {
                add: {
                  id: '{{ "msg_" + crypto.randomUUID() }}', // Gemini does not provide a request ID, so we generate one.
                  type: 'message',
                  role: 'assistant',
                  model: '{{ body.modelVersion || (body.candidates && body.candidates[0] && body.candidates[0].model) }}', // Fallback for different Gemini versions
                  content: '{{ (body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts) ? body.candidates[0].content.parts.map(p => p.functionCall ? ({ type: "tool_use", id: p.functionCall.name, name: p.functionCall.name, input: p.functionCall.args }) : p.thought ? ({ type: "thinking", thinking: p.thought }) : ({ type: "text", text: p.text })) : [] }}',
                  stop_reason: '{{ (body.candidates && body.candidates[0] && body.candidates[0].finishReason === "MAX_TOKENS") ? "max_tokens" : ((body.candidates && body.candidates[0] && body.candidates[0].finishReason === "TOOL_USE") ? "tool_use" : "stop") }}',
                  usage: {
                    input_tokens: '{{ (body.usageMetadata && body.usageMetadata.promptTokenCount) || 0 }}',
                    output_tokens: '{{ (body.usageMetadata && body.usageMetadata.candidatesTokenCount) || 0 }}',
                  },
                },
                remove: ['candidates', 'usageMetadata', 'modelVersion', 'responseId'],
              },
            },
            stream: {
              start: {
                body: {
                  add: {
                    type: 'message_start',
                    message: {
                      id: '{{ "msg_" + crypto.randomUUID() }}',
                      type: 'message',
                      role: 'assistant',
                      content: [],
                      model: '{{ body.modelVersion || "gemini-2.5-pro" }}',
                      stop_reason: null,
                      usage: {
                        input_tokens: '{{ (body.usageMetadata && body.usageMetadata.promptTokenCount) || 0 }}',
                        output_tokens: 0
                      }
                    }
                  },
                  remove: ['candidates', 'usageMetadata', 'modelVersion', 'responseId']
                }
              },
              chunk: {
                body: {
                  add: {
                    type: '{{ (body.candidates && body.candidates[0] && body.candidates[0].finishReason) ? "content_block_stop" : (stream.chunkIndex === 0 ? "content_block_start" : "content_block_delta") }}',
                    index: 0,
                    content_block: '{{ stream.chunkIndex === 0 ? ((body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts && body.candidates[0].content.parts[0] && body.candidates[0].content.parts[0].thought) ? { type: "thinking", thinking: "" } : { type: "text", text: "" }) : undefined }}',
                    delta: '{{ (body.candidates && body.candidates[0] && !body.candidates[0].finishReason) ? ((body.candidates[0].content && body.candidates[0].content.parts && body.candidates[0].content.parts[0] && body.candidates[0].content.parts[0].thought) ? { type: "thinking_delta", thinking: body.candidates[0].content.parts[0].thought } : { type: "text_delta", text: (body.candidates[0].content && body.candidates[0].content.parts && body.candidates[0].content.parts[0] && body.candidates[0].content.parts[0].text) || "" }) : undefined }}'
                  },
                  remove: ['candidates', 'usageMetadata', 'modelVersion', 'responseId']
                }
              },
              end: {
                body: {
                  add: {
                    __multi_events: [
                      {
                        type: 'message_delta',
                        delta: {
                          stop_reason: '{{ (body.candidates && body.candidates[0] && body.candidates[0].finishReason === "MAX_TOKENS") ? "max_tokens" : "end_turn" }}',
                          usage: {
                            output_tokens: '{{ (body.usageMetadata && body.usageMetadata.candidatesTokenCount) || 0 }}'
                          }
                        }
                      },
                      {
                        type: 'message_stop'
                      }
                    ]
                  },
                  remove: ['candidates', 'usageMetadata', 'modelVersion', 'responseId']
                }
              }
            },
          }
        },
        {
          match: { status: "^[45]..$" },
          rules: {
            default: {
              body: {
                add: {
                  type: 'error',
                  error: {
                    type: 'api_error',
                    message: '{{body.error.message}}'
                  }
                },
                remove: ['error']
              }
            }
          }
        }
      ],
    },
  ],
};
