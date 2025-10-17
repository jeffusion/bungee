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
            // Model is required by Anthropic
            model: '{{ body.model }}',

            // Extract system messages
            system: '{{ body.messages.filter(m => m.role === "system").map(m => m.content).join("\\n") || undefined }}',

            // Convert messages with tool calls, tool results, and multi-modal support
            messages: '{{ (() => { const msgs = []; const filtered = body.messages.filter(m => m.role !== "system"); for (const msg of filtered) { const role = msg.role; if (role === "user") { const content = msg.content; if (typeof content === "string") { const textContent = content.trim(); if (!textContent) continue; const thinkingMatch = /<thinking>\\s*([\\s\\S]*?)\\s*<\\/thinking>/g; const matches = []; let match; let lastIdx = 0; const blocks = []; while ((match = thinkingMatch.exec(content)) !== null) { const beforeText = content.substring(lastIdx, match.index).trim(); if (beforeText) blocks.push({ type: "text", text: beforeText }); const thinkingText = match[1].trim(); if (thinkingText) blocks.push({ type: "thinking", thinking: thinkingText }); lastIdx = match.index + match[0].length; } const afterText = content.substring(lastIdx).trim(); if (afterText) blocks.push({ type: "text", text: afterText }); if (blocks.length === 0) { msgs.push({ role: "user", content: textContent }); } else if (blocks.length === 1 && blocks[0].type === "text") { msgs.push({ role: "user", content: blocks[0].text }); } else { msgs.push({ role: "user", content: blocks }); } } else if (Array.isArray(content)) { const images = []; const texts = []; const others = []; for (const item of content) { if (item.type === "image_url") images.push(item); else if (item.type === "text") texts.push(item); else others.push(item); } const anthropicContent = []; for (const img of images) { const url = img.image_url?.url || ""; if (url.startsWith("data:")) { const parts = url.split(";base64,"); if (parts.length === 2) { const mediaType = parts[0].replace("data:", ""); anthropicContent.push({ type: "image", source: { type: "base64", media_type: mediaType, data: parts[1] } }); } } } for (const txt of texts) { const textContent = txt.text || ""; if (textContent.trim()) anthropicContent.push({ type: "text", text: textContent }); } anthropicContent.push(...others); if (anthropicContent.length > 0) { if (anthropicContent.length === 1 && anthropicContent[0].type === "text") { msgs.push({ role: "user", content: anthropicContent[0].text }); } else { msgs.push({ role: "user", content: anthropicContent }); } } } } else if (role === "assistant") { if (msg.tool_calls) { const content = []; for (const tc of msg.tool_calls) { if (tc.type === "function" && tc.function) { const argsStr = tc.function.arguments || "{}"; let argsObj = {}; try { argsObj = typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr; } catch (e) {} content.push({ type: "tool_use", id: tc.id || "", name: tc.function.name || "", input: argsObj }); } } if (content.length > 0) msgs.push({ role: "assistant", content }); } else { const content = msg.content || ""; if (content.trim()) msgs.push({ role: "assistant", content }); } } else if (role === "tool") { const toolCallId = msg.tool_call_id || ""; const content = String(msg.content || ""); msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolCallId, content }] }); } } return msgs; })() }}',

            // Max tokens - required by Anthropic, with fallback to env var
            max_tokens: '{{ body.max_tokens || (process.env.ANTHROPIC_MAX_TOKENS ? parseInt(process.env.ANTHROPIC_MAX_TOKENS) : undefined) }}',

            // Other parameters
            temperature: '{{ body.temperature }}',
            top_p: '{{ body.top_p }}',
            stop_sequences: '{{ body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : undefined }}',
            stream: '{{ body.stream }}',

            // Tools conversion
            tools: '{{ body.tools ? body.tools.filter(t => t.type === "function" && t.function).map(t => ({ name: t.function.name || "", description: t.function.description || "", input_schema: t.function.parameters || {} })) : undefined }}',

            // Thinking budget conversion for reasoning models
            thinking: '{{ body.max_completion_tokens ? (() => { const effort = body.reasoning_effort || "medium"; const envKey = `OPENAI_${effort.toUpperCase()}_TO_ANTHROPIC_TOKENS`; const tokens = process.env[envKey]; if (!tokens) throw new Error(`Environment variable ${envKey} not configured for reasoning_effort conversion`); const thinkingBudget = parseInt(tokens); if (isNaN(thinkingBudget)) throw new Error(`Invalid ${envKey} value: must be integer`); return { type: "enabled", budget_tokens: thinkingBudget }; })() : undefined }}'
          },
          remove: ['model', 'stop', 'n', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'user', 'max_tokens', 'max_completion_tokens', 'reasoning_effort'],
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
                  choices: [{
                    index: 0,
                    message: '{{ (() => { const content = body.content || []; let textContent = ""; const toolCalls = []; let thinkingContent = ""; for (const item of content) { if (item.type === "text") { textContent += item.text || ""; } else if (item.type === "thinking") { thinkingContent += item.thinking || ""; } else if (item.type === "tool_use") { toolCalls.push({ id: item.id || "", type: "function", function: { name: item.name || "", arguments: JSON.stringify(item.input || {}) } }); } } if (thinkingContent.trim()) { textContent = `<thinking>\\n${thinkingContent.trim()}\\n</thinking>\\n\\n${textContent}`; } const msg = { role: "assistant" }; if (toolCalls.length > 0) { msg.content = textContent || null; msg.tool_calls = toolCalls; } else { msg.content = textContent; } return msg; })() }}',
                    finish_reason: '{{ (() => { const sr = body.stop_reason; if (sr === "tool_use") return "tool_calls"; if (sr === "end_turn") return "stop"; if (sr === "max_tokens") return "length"; if (sr === "stop_sequence") return "stop"; return "stop"; })() }}'
                  }],
                  usage: {
                    prompt_tokens: '{{ body.usage?.input_tokens || 0 }}',
                    completion_tokens: '{{ body.usage?.output_tokens || 0 }}',
                    total_tokens: '{{ (body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0) }}'
                  }
                },
                remove: ['type', 'role', 'content', 'stop_reason', 'stop_sequence'],
              },
            },
            stream: {
              // Event type mapping (Anthropic SSE format)
              eventTypeMapping: {
                'message_start': 'start',
                'content_block_start': 'chunk',
                'content_block_delta': 'chunk',
                'content_block_stop': 'skip',
                'message_delta': 'end',
                'message_stop': 'skip',
                'ping': 'skip'
              },
              start: {
                body: {
                  add: {
                    id: '{{ "chatcmpl-" + (stream.streamId || crypto.randomUUID()) }}',
                    object: 'chat.completion.chunk',
                    created: '{{ Math.floor(Date.now() / 1000) }}',
                    model: '{{ body.message?.model || "claude" }}',
                    choices: [{
                      index: 0,
                      delta: { role: 'assistant' },
                      finish_reason: null
                    }]
                  },
                  remove: ['type', 'message']
                }
              },
              chunk: {
                body: {
                  add: {
                    id: '{{ "chatcmpl-" + (stream.streamId || crypto.randomUUID()) }}',
                    object: 'chat.completion.chunk',
                    created: '{{ Math.floor(Date.now() / 1000) }}',
                    model: '{{ body.message?.model || "claude" }}',
                    choices: [{
                      index: 0,
                      delta: '{{ (() => { const delta = {}; const eventType = body.type; if (eventType === "content_block_start") { const cb = body.content_block || {}; if (cb.type === "tool_use") { delta.tool_calls = [{ index: body.index || 0, id: cb.id || "", type: "function", function: { name: cb.name || "" } }]; } } else if (eventType === "content_block_delta") { const d = body.delta || {}; if (d.type === "text_delta") { delta.content = d.text || ""; } else if (d.type === "thinking_delta") { delta.content = `<thinking>${d.thinking || ""}</thinking>`; } else if (d.type === "input_json_delta") { delta.tool_calls = [{ index: body.index || 0, function: { arguments: d.partial_json || "" } }]; } } return delta; })() }}',
                      finish_reason: null
                    }]
                  },
                  remove: ['type', 'index', 'content_block', 'delta']
                }
              },
              end: {
                body: {
                  add: {
                    id: '{{ "chatcmpl-" + (stream.streamId || crypto.randomUUID()) }}',
                    object: 'chat.completion.chunk',
                    created: '{{ Math.floor(Date.now() / 1000) }}',
                    model: '{{ body.message?.model || "claude" }}',
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: '{{ (() => { const sr = body.delta?.stop_reason; if (sr === "tool_use") return "tool_calls"; if (sr === "max_tokens") return "length"; if (sr === "stop_sequence") return "stop"; return "stop"; })() }}'
                    }],
                    usage: '{{ body.usage ? { prompt_tokens: body.usage.input_tokens || 0, completion_tokens: body.delta?.usage?.output_tokens || 0, total_tokens: (body.usage.input_tokens || 0) + (body.delta?.usage?.output_tokens || 0) } : undefined }}'
                  },
                  remove: ['type', 'delta']
                }
              }
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
                      text: '{{body.choices?.[0]?.message?.content}}',
                    },
                  ],
                  stop_reason: '{{body.choices?.[0]?.finish_reason}}',
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
                  model: '{{ body.modelVersion ?? body.candidates?.[0]?.model }}', // Fallback for different Gemini versions
                  content: '{{ body.candidates?.[0]?.content?.parts?.map(p => p.functionCall ? ({ type: "tool_use", id: p.functionCall.name, name: p.functionCall.name, input: p.functionCall.args }) : p.thought ? ({ type: "thinking", thinking: p.thought }) : ({ type: "text", text: p.text })) ?? [] }}',
                  stop_reason: '{{ body.candidates?.[0]?.finishReason === "MAX_TOKENS" ? "max_tokens" : (body.candidates?.[0]?.finishReason === "TOOL_USE" ? "tool_use" : "stop") }}',
                  usage: {
                    input_tokens: '{{ body.usageMetadata?.promptTokenCount ?? 0 }}',
                    output_tokens: '{{ body.usageMetadata?.candidatesTokenCount ?? 0 }}',
                  },
                },
                remove: ['candidates', 'modelVersion', 'responseId'],
              },
            },
            stream: {
              // ✅ 阶段检测表达式（Gemini SSE 格式，不带 event: 字段）
              phaseDetection: {
                isEnd: '{{ body.candidates?.[0]?.finishReason }}'
              },
              start: {
                body: {
                  add: {
                    type: 'message_start',
                    message: {
                      id: '{{ "msg_" + crypto.randomUUID() }}',
                      type: 'message',
                      role: 'assistant',
                      content: [],
                      model: '{{ body.modelVersion ?? "gemini-2.5-pro" }}',
                      stop_reason: null,
                      usage: {
                        input_tokens: '{{ body.usageMetadata?.promptTokenCount ?? 0 }}',
                        output_tokens: 0
                      }
                    }
                  },
                  remove: ['candidates', 'modelVersion', 'responseId']
                }
              },
              chunk: {
                body: {
                  add: {
                    type: '{{ body.candidates?.[0]?.finishReason ? "content_block_stop" : (stream.chunkIndex === 0 ? "content_block_start" : "content_block_delta") }}',
                    index: 0,
                    content_block: '{{ stream.chunkIndex === 0 ? (body.candidates?.[0]?.content?.parts?.[0]?.thought ? { type: "thinking", thinking: "" } : { type: "text", text: "" }) : undefined }}',
                    delta: '{{ (body.candidates?.[0] && !body.candidates[0].finishReason) ? (body.candidates[0].content?.parts?.[0]?.thought ? { type: "thinking_delta", thinking: body.candidates[0].content.parts[0].thought } : { type: "text_delta", text: body.candidates[0].content?.parts?.[0]?.text ?? "" }) : undefined }}'
                  },
                  remove: ['candidates', 'modelVersion', 'responseId']
                }
              },
              end: {
                body: {
                  add: {
                    __multi_events: [
                      {
                        type: 'message_delta',
                        delta: {
                          stop_reason: '{{ body.candidates?.[0]?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn" }}',
                          usage: {
                            output_tokens: '{{ body.usageMetadata?.candidatesTokenCount ?? 0 }}'
                          }
                        }
                      },
                      {
                        type: 'message_stop'
                      }
                    ]
                  },
                  remove: ['candidates', 'modelVersion', 'responseId']
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
  'openai-to-gemini': [
    {
      path: {
        action: 'replace',
        match: '^/v1/chat/completions$',
        replace: "{{ body.stream ? `/v1beta/models/${body.model}:streamGenerateContent?alt=sse` : `/v1beta/models/${body.model}:generateContent` }}"
      },
      request: {
        body: {
          add: {
            // System message handling
            system_instruction: '{{ body.messages.filter(m => m.role === "system").length > 0 ? { parts: [{ text: body.messages.filter(m => m.role === "system").map(m => m.content).join("\\n") }] } : undefined }}',

            // Convert messages (filter out system messages, convert roles)
            contents: '{{ body.messages.filter(m => m.role !== "system").map(m => { if (m.tool_calls) { return { role: "model", parts: m.tool_calls.map(tc => ({ functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") } })) }; } else if (m.role === "tool") { const fnName = m.tool_call_id.startsWith("call_") ? m.tool_call_id.split("_").slice(1, -1).join("_") : m.tool_call_id; const resp = typeof m.content === "object" ? m.content : { content: m.content }; return { role: "tool", parts: [{ functionResponse: { name: fnName, response: resp } }] }; } else { const role = m.role === "assistant" ? "model" : "user"; if (typeof m.content === "string") { return { role, parts: [{ text: m.content }] }; } else if (Array.isArray(m.content)) { return { role, parts: m.content.map(c => { if (c.type === "text") return { text: c.text }; if (c.type === "image_url") { const url = c.image_url.url; const [mimeType, data] = url.replace("data:", "").split(";base64,"); return { inlineData: { mimeType, data } }; } return { text: "" }; }) }; } else { return { role, parts: [{ text: "" }] }; } } }) }}',

            // Generation config
            generationConfig: {
              temperature: '{{ body.temperature }}',
              topP: '{{ body.top_p }}',
              maxOutputTokens: '{{ body.max_tokens || (process.env.ANTHROPIC_MAX_TOKENS ? parseInt(process.env.ANTHROPIC_MAX_TOKENS) : undefined) }}',
              stopSequences: '{{ body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : undefined }}',

              // Thinking budget conversion for reasoning models
              thinkingConfig: '{{ body.max_completion_tokens ? (() => { const effort = body.reasoning_effort || "medium"; const envKey = `OPENAI_${effort.toUpperCase()}_TO_GEMINI_TOKENS`; const tokens = process.env[envKey]; if (!tokens) throw new Error(`Environment variable ${envKey} not configured`); return { thinkingBudget: parseInt(tokens) }; })() : undefined }}',

              // Response format for structured output
              response_mime_type: '{{ body.response_format?.type === "json_schema" ? "application/json" : undefined }}',
              response_schema: '{{ body.response_format?.json_schema?.schema }}'
            },

            // Tools conversion
            tools: '{{ body.tools ? [{ functionDeclarations: body.tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: deepClean(t.function.parameters, ["$schema", "additionalProperties", "title", "minLength", "maxLength", "minimum", "maximum", "pattern", "format"]) })) }] : undefined }}'
          },
          remove: ['model', 'messages', 'max_tokens', 'temperature', 'top_p', 'stop', 'n', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'user', 'stream', 'max_completion_tokens', 'reasoning_effort', 'response_format']
        }
      },
      response: [
        {
          match: { status: "^2..$" },
          rules: {
            default: {
              body: {
                add: {
                  id: '{{ "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").substring(0, 29) }}',
                  object: 'chat.completion',
                  created: '{{ Math.floor(Date.now() / 1000) }}',
                  model: '{{ body.modelVersion || body.candidates?.[0]?.model || "gemini-pro" }}',
                  choices: [{
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: '{{ (() => { const parts = body.candidates?.[0]?.content?.parts || []; const textParts = parts.filter(p => p.text).map(p => p.text); return textParts.join(""); })() }}',
                      tool_calls: '{{ (() => { const parts = body.candidates?.[0]?.content?.parts || []; const fcParts = parts.filter(p => p.functionCall); if (fcParts.length === 0) return undefined; return fcParts.map((p, i) => ({ id: `call_${p.functionCall.name}_${crypto.randomUUID().replace(/-/g, "").substring(0, 8)}`, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) } })); })() }}'
                    },
                    finish_reason: '{{ (() => { const parts = body.candidates?.[0]?.content?.parts || []; if (parts.some(p => p.functionCall)) return "tool_calls"; const reason = body.candidates?.[0]?.finishReason; if (reason === "MAX_TOKENS") return "length"; if (reason === "SAFETY" || reason === "RECITATION") return "content_filter"; return "stop"; })() }}'
                  }],
                  usage: {
                    prompt_tokens: '{{ body.usageMetadata?.promptTokenCount || 0 }}',
                    completion_tokens: '{{ body.usageMetadata?.candidatesTokenCount || 0 }}',
                    total_tokens: '{{ body.usageMetadata?.totalTokenCount || 0 }}'
                  }
                },
                remove: ['candidates', 'usageMetadata', 'modelVersion']
              }
            },
            stream: {
              // Gemini streaming format (no event: prefix)
              phaseDetection: {
                isEnd: '{{ body.candidates?.[0]?.finishReason }}'
              },
              start: {
                body: {
                  add: {
                    id: '{{ "chatcmpl-" + (stream.streamId || crypto.randomUUID().replace(/-/g, "").substring(0, 29)) }}',
                    object: 'chat.completion.chunk',
                    created: '{{ Math.floor(Date.now() / 1000) }}',
                    model: '{{ body.modelVersion || body.candidates?.[0]?.model || "gemini-pro" }}',
                    choices: [{
                      index: 0,
                      delta: { role: 'assistant' },
                      finish_reason: null
                    }]
                  },
                  remove: ['candidates', 'usageMetadata']
                }
              },
              chunk: {
                body: {
                  add: {
                    id: '{{ "chatcmpl-" + (stream.streamId || crypto.randomUUID().replace(/-/g, "").substring(0, 29)) }}',
                    object: 'chat.completion.chunk',
                    created: '{{ Math.floor(Date.now() / 1000) }}',
                    model: '{{ body.modelVersion || body.candidates?.[0]?.model || "gemini-pro" }}',
                    choices: [{
                      index: 0,
                      delta: {
                        content: '{{ body.candidates?.[0]?.content?.parts?.[0]?.text || "" }}',
                        tool_calls: '{{ (() => { const parts = body.candidates?.[0]?.content?.parts || []; const fc = parts.find(p => p.functionCall); if (!fc) return undefined; return [{ index: 0, id: `call_${fc.functionCall.name}_${crypto.randomUUID().replace(/-/g, "").substring(0, 8)}`, type: "function", function: { name: fc.functionCall.name, arguments: JSON.stringify(fc.functionCall.args) } }]; })() }}'
                      },
                      finish_reason: null
                    }]
                  },
                  remove: ['candidates', 'usageMetadata']
                }
              },
              end: {
                body: {
                  add: {
                    id: '{{ "chatcmpl-" + (stream.streamId || crypto.randomUUID().replace(/-/g, "").substring(0, 29)) }}',
                    object: 'chat.completion.chunk',
                    created: '{{ Math.floor(Date.now() / 1000) }}',
                    model: '{{ body.modelVersion || body.candidates?.[0]?.model || "gemini-pro" }}',
                    choices: [{
                      index: 0,
                      delta: {
                        content: '{{ body.candidates?.[0]?.content?.parts?.[0]?.text || "" }}'
                      },
                      finish_reason: '{{ body.candidates?.[0]?.finishReason === "MAX_TOKENS" ? "length" : (body.candidates?.[0]?.finishReason === "SAFETY" ? "content_filter" : "stop") }}'
                    }],
                    usage: {
                      prompt_tokens: '{{ body.usageMetadata?.promptTokenCount || 0 }}',
                      completion_tokens: '{{ body.usageMetadata?.candidatesTokenCount || 0 }}',
                      total_tokens: '{{ body.usageMetadata?.totalTokenCount || 0 }}'
                    }
                  },
                  remove: ['candidates', 'usageMetadata']
                }
              }
            }
          }
        },
        {
          match: { status: "^[45]..$" },
          rules: {
            default: {
              body: {
                add: {
                  error: {
                    message: '{{ body.error?.message || "Unknown error" }}',
                    type: 'api_error',
                    code: '{{ body.error?.code || null }}'
                  }
                },
                remove: ['error']
              }
            }
          }
        }
      ]
    }
  ],
  'gemini-to-openai': [
    {
      path: {
        action: 'replace',
        match: '^/v1.*/(generateContent|streamGenerateContent)$',
        replace: '/v1/chat/completions'
      },
      request: {
        body: {
          add: {
            // Preserve model name - use a fallback since Gemini path doesn't contain model
            model: '{{ body.model || "gemini-pro" }}',

            // Convert messages: systemInstruction + contents
            messages: '{{ (() => { const msgs = []; const sysInst = body.systemInstruction || body.system_instruction; if (sysInst) { const sysParts = sysInst.parts || []; const sysText = sysParts.map(p => p.text || "").join(""); if (sysText) msgs.push({ role: "system", content: sysText }); } const contents = body.contents || []; contents.forEach(c => { const role = c.role; const parts = c.parts || []; if (role === "user") { const hasFunctionResponse = parts.some(p => p.functionResponse); if (hasFunctionResponse) { parts.forEach(p => { if (p.functionResponse) { const fr = p.functionResponse; const content = typeof fr.response === "object" ? (fr.response.content || JSON.stringify(fr.response)) : String(fr.response); msgs.push({ role: "tool", tool_call_id: "call_" + fr.name + "_0001", content }); } }); } else { const content = parts.length === 1 && parts[0].text ? parts[0].text : parts.map(p => { if (p.text) return { type: "text", text: p.text }; if (p.inlineData) return { type: "image_url", image_url: { url: "data:" + p.inlineData.mimeType + ";base64," + p.inlineData.data } }; return { type: "text", text: "" }; }); msgs.push({ role: "user", content }); } } else if (role === "model") { const textContent = parts.filter(p => p.text).map(p => p.text).join(""); const functionCalls = parts.filter(p => p.functionCall); if (functionCalls.length > 0) { const toolCalls = functionCalls.map((p, i) => ({ id: "call_" + p.functionCall.name + "_" + String(i + 1).padStart(4, "0"), type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } })); msgs.push({ role: "assistant", content: textContent || null, tool_calls: toolCalls }); } else { msgs.push({ role: "assistant", content: textContent }); } } else if (role === "tool") { parts.forEach(p => { if (p.functionResponse) { const fr = p.functionResponse; const content = typeof fr.response === "object" ? (fr.response.content || JSON.stringify(fr.response)) : String(fr.response); msgs.push({ role: "tool", tool_call_id: "call_" + fr.name + "_0001", content }); } }); } }); return msgs; })() }}',

            // Map generation config
            temperature: '{{ body.generationConfig?.temperature }}',
            top_p: '{{ body.generationConfig?.topP }}',
            max_tokens: '{{ body.generationConfig?.maxOutputTokens || (process.env.ANTHROPIC_MAX_TOKENS ? parseInt(process.env.ANTHROPIC_MAX_TOKENS) : undefined) }}',
            stop: '{{ body.generationConfig?.stopSequences }}',

            // Response format
            response_format: '{{ body.generationConfig?.response_mime_type === "application/json" ? (body.generationConfig?.response_schema ? { type: "json_schema", json_schema: { name: "response", strict: true, schema: body.generationConfig.response_schema } } : { type: "json_object" }) : undefined }}',

            // Tools conversion
            tools: '{{ body.tools ? body.tools.flatMap(t => { const funcKey = t.function_declarations || t.functionDeclarations; if (!funcKey) return []; return funcKey.map(f => ({ type: "function", function: { name: f.name, description: f.description, parameters: (() => { const schema = f.parameters || {}; const convert = (obj) => { if (typeof obj !== "object" || obj === null) return obj; if (Array.isArray(obj)) return obj.map(convert); const result = {}; for (const [key, value] of Object.entries(obj)) { if (key === "type" && typeof value === "string") { const typeMap = { STRING: "string", NUMBER: "number", INTEGER: "integer", BOOLEAN: "boolean", ARRAY: "array", OBJECT: "object" }; result[key] = typeMap[value.toUpperCase()] || value.toLowerCase(); } else { result[key] = convert(value); } } return result; }; return convert(schema); })() } })); }) : undefined }}',
            tool_choice: '{{ body.tools ? "auto" : undefined }}',

            // Thinking budget conversion
            reasoning_effort: '{{ (() => { const tc = body.generationConfig?.thinkingConfig; if (!tc || !tc.thinkingBudget || tc.thinkingBudget === 0) return undefined; const budget = tc.thinkingBudget; if (budget === -1) return "high"; const lowThreshold = parseInt(process.env.GEMINI_TO_OPENAI_LOW_REASONING_THRESHOLD || "0"); const highThreshold = parseInt(process.env.GEMINI_TO_OPENAI_HIGH_REASONING_THRESHOLD || "0"); if (!lowThreshold || !highThreshold) throw new Error("GEMINI_TO_OPENAI_LOW_REASONING_THRESHOLD and GEMINI_TO_OPENAI_HIGH_REASONING_THRESHOLD must be set"); if (budget <= lowThreshold) return "low"; if (budget <= highThreshold) return "medium"; return "high"; })() }}',
            max_completion_tokens: '{{ (() => { const tc = body.generationConfig?.thinkingConfig; if (!tc || !tc.thinkingBudget || tc.thinkingBudget === 0) return undefined; const maxTokens = body.generationConfig?.maxOutputTokens || parseInt(process.env.OPENAI_REASONING_MAX_TOKENS || "0"); if (!maxTokens) throw new Error("maxOutputTokens or OPENAI_REASONING_MAX_TOKENS required for reasoning models"); return maxTokens; })() }}',

            // Stream flag
            stream: '{{ body.stream }}'
          },
          remove: ['contents', 'systemInstruction', 'system_instruction', 'generationConfig']
        }
      },
      response: [
        {
          match: { status: '^2..$' },
          rules: {
            default: {
              body: {
                add: {
                  candidates: [{
                    content: {
                      parts: '{{ (() => { const choice = body.choices?.[0]; if (!choice) return [{ text: "" }]; const msg = choice.message || {}; const parts = []; if (msg.content) parts.push({ text: msg.content }); if (msg.tool_calls) { msg.tool_calls.forEach(tc => { if (tc.type === "function" && tc.function) { const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments || "{}") : tc.function.arguments; parts.push({ functionCall: { name: tc.function.name, args } }); } }); } if (parts.length === 0) parts.push({ text: "" }); return parts; })() }}',
                      role: 'model'
                    },
                    finishReason: '{{ (() => { const fr = body.choices?.[0]?.finish_reason; if (fr === "stop") return "STOP"; if (fr === "length") return "MAX_TOKENS"; if (fr === "content_filter") return "SAFETY"; if (fr === "tool_calls") return "STOP"; return "STOP"; })() }}',
                    index: 0
                  }],
                  usageMetadata: {
                    promptTokenCount: '{{ body.usage?.prompt_tokens || 0 }}',
                    candidatesTokenCount: '{{ body.usage?.completion_tokens || 0 }}',
                    totalTokenCount: '{{ body.usage?.total_tokens || 0 }}'
                  }
                },
                remove: ['id', 'object', 'created', 'model', 'choices', 'system_fingerprint']
              }
            },
            stream: {
              // OpenAI streaming format (uses 'data: ' prefix)
              phaseDetection: {
                isEnd: '{{ body.choices?.[0]?.finish_reason }}'
              },
              start: {
                body: {
                  add: {
                    candidates: [{
                      content: {
                        parts: [],
                        role: 'model'
                      },
                      index: 0
                    }]
                  },
                  remove: ['id', 'object', 'created', 'model', 'choices', 'system_fingerprint']
                }
              },
              chunk: {
                body: {
                  add: {
                    candidates: [{
                      content: {
                        parts: '{{ (() => { const delta = body.choices?.[0]?.delta; if (!delta) return []; const parts = []; if (delta.content) parts.push({ text: delta.content }); if (delta.tool_calls) { delta.tool_calls.forEach(tc => { if (tc.function) { const args = tc.function.arguments || "{}"; const argsObj = typeof args === "string" ? JSON.parse(args) : args; parts.push({ functionCall: { name: tc.function.name || "", args: argsObj } }); } }); } return parts; })() }}',
                        role: 'model'
                      },
                      index: 0
                    }]
                  },
                  remove: ['id', 'object', 'created', 'model', 'choices', 'system_fingerprint']
                }
              },
              end: {
                body: {
                  add: {
                    candidates: [{
                      content: {
                        parts: '{{ (() => { const delta = body.choices?.[0]?.delta; const parts = []; if (delta?.content) parts.push({ text: delta.content }); if (parts.length === 0) parts.push({ text: "" }); return parts; })() }}',
                        role: 'model'
                      },
                      finishReason: '{{ (() => { const fr = body.choices?.[0]?.finish_reason; if (fr === "stop") return "STOP"; if (fr === "length") return "MAX_TOKENS"; if (fr === "content_filter") return "SAFETY"; return "STOP"; })() }}',
                      index: 0
                    }],
                    usageMetadata: {
                      promptTokenCount: '{{ body.usage?.prompt_tokens || 0 }}',
                      candidatesTokenCount: '{{ body.usage?.completion_tokens || 0 }}',
                      totalTokenCount: '{{ body.usage?.total_tokens || 0 }}'
                    }
                  },
                  remove: ['id', 'object', 'created', 'model', 'choices', 'system_fingerprint']
                }
              }
            }
          }
        },
        {
          match: { status: '^[45]..$' },
          rules: {
            default: {
              body: {
                add: {
                  error: {
                    message: '{{ body.error?.message || "Unknown error" }}',
                    code: '{{ body.error?.code }}',
                    status: '{{ body.error?.type }}'
                  }
                },
                remove: ['error']
              }
            }
          }
        }
      ]
    }
  ],
  'gemini-to-anthropic': [
    {
      path: {
        action: 'replace',
        match: '^/v1.*/(generateContent|streamGenerateContent)$',
        replace: '/v1/messages'
      },
      request: {
        body: {
          add: {
            // Preserve model name
            model: '{{ body.model || "claude-3-opus-20240229" }}',

            // Convert system instruction
            system: '{{ (() => { const sysInst = body.systemInstruction || body.system_instruction; if (!sysInst) return undefined; const parts = sysInst.parts || []; return parts.map(p => p.text || "").join(""); })() }}',

            // Convert messages
            messages: '{{ (() => { const contents = body.contents || []; const msgs = []; contents.forEach(c => { const role = c.role; const parts = c.parts || []; let anthropicRole = role === "model" ? "assistant" : (role === "tool" ? "user" : "user"); const content = []; for (const part of parts) { if (part.text) { const text = part.text.trim(); if (text) { if (part.thought) { content.push({ type: "thinking", thinking: text }); } else { content.push({ type: "text", text }); } } } else if (part.inlineData) { content.push({ type: "image", source: { type: "base64", media_type: part.inlineData.mimeType || "image/jpeg", data: part.inlineData.data || "" } }); } else if (part.functionCall) { const fc = part.functionCall; content.push({ type: "tool_use", id: "toolu_" + fc.name + "_" + Math.random().toString(36).substring(2, 15), name: fc.name, input: fc.args || {} }); } else if (part.functionResponse) { const fr = part.functionResponse; const respContent = typeof fr.response === "object" ? (fr.response.content || JSON.stringify(fr.response)) : String(fr.response); content.push({ type: "tool_result", tool_use_id: "toolu_" + fr.name + "_" + Math.random().toString(36).substring(2, 15), content: respContent }); } } if (content.length === 0) return; if (content.length === 1 && content[0].type === "text") { msgs.push({ role: anthropicRole, content: content[0].text }); } else { msgs.push({ role: anthropicRole, content }); } }); return msgs; })() }}',

            // Map generation config
            temperature: '{{ body.generationConfig?.temperature }}',
            top_p: '{{ body.generationConfig?.topP }}',
            top_k: '{{ body.generationConfig?.topK }}',
            max_tokens: '{{ body.generationConfig?.maxOutputTokens || (process.env.ANTHROPIC_MAX_TOKENS ? parseInt(process.env.ANTHROPIC_MAX_TOKENS) : undefined) }}',
            stop_sequences: '{{ body.generationConfig?.stopSequences }}',

            // Tools conversion
            tools: '{{ body.tools ? body.tools.flatMap(t => { const funcKey = t.function_declarations || t.functionDeclarations; if (!funcKey) return []; return funcKey.map(f => { const schema = f.parameters || {}; const convert = (obj) => { if (typeof obj !== "object" || obj === null) return obj; if (Array.isArray(obj)) return obj.map(convert); const result = {}; for (const [key, value] of Object.entries(obj)) { if (key === "type" && typeof value === "string") { const typeMap = { STRING: "string", NUMBER: "number", INTEGER: "integer", BOOLEAN: "boolean", ARRAY: "array", OBJECT: "object" }; result[key] = typeMap[value.toUpperCase()] || value.toLowerCase(); } else { result[key] = convert(value); } } return result; }; return { name: f.name, description: f.description, input_schema: convert(schema) }; }); }) : undefined }}',

            // Thinking budget conversion
            thinking: '{{ (() => { const tc = body.generationConfig?.thinkingConfig; if (!tc || !tc.thinkingBudget) return undefined; const budget = tc.thinkingBudget; if (budget === 0) return undefined; if (budget === -1) return { type: "enabled" }; return { type: "enabled", budget_tokens: budget }; })() }}',

            // Stream flag
            stream: '{{ body.stream }}'
          },
          remove: ['contents', 'systemInstruction', 'system_instruction', 'generationConfig', 'tools']
        }
      },
      response: [
        {
          match: { status: '^2..$' },
          rules: {
            default: {
              body: {
                add: {
                  candidates: [{
                    content: {
                      parts: '{{ (() => { const content = body.content; if (!content) return [{ text: "" }]; const parts = []; if (typeof content === "string") { if (content.trim()) parts.push({ text: content }); } else if (Array.isArray(content)) { for (const item of content) { const type = item.type; if (type === "text") { const text = item.text || ""; if (text.trim()) parts.push({ text }); } else if (type === "thinking") { const thinking = item.thinking || ""; if (thinking.trim()) parts.push({ text: thinking, thought: true }); } else if (type === "tool_use") { parts.push({ functionCall: { name: item.name || "", args: item.input || {} } }); } } } if (parts.length === 0) parts.push({ text: "" }); return parts; })() }}',
                      role: 'model'
                    },
                    finishReason: '{{ (() => { const sr = body.stop_reason; if (sr === "end_turn") return "STOP"; if (sr === "max_tokens") return "MAX_TOKENS"; if (sr === "stop_sequence") return "STOP"; if (sr === "tool_use") return "STOP"; return "STOP"; })() }}',
                    index: 0
                  }],
                  usageMetadata: {
                    promptTokenCount: '{{ body.usage?.input_tokens || 0 }}',
                    candidatesTokenCount: '{{ body.usage?.output_tokens || 0 }}',
                    totalTokenCount: '{{ (body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0) }}'
                  }
                },
                remove: ['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence']
              }
            },
            stream: {
              // Anthropic streaming format (uses event: prefix)
              eventTypeMapping: {
                'message_start': 'skip',
                'content_block_start': 'skip',
                'content_block_delta': 'chunk',
                'content_block_stop': 'skip',
                'message_delta': 'end',
                'message_stop': 'skip',
                'ping': 'skip'
              },
              chunk: {
                body: {
                  add: {
                    candidates: [{
                      content: {
                        parts: '{{ (() => { const delta = body.delta; if (!delta) return []; const parts = []; if (delta.type === "text_delta") { const text = delta.text || ""; if (text) parts.push({ text }); } else if (delta.type === "thinking_delta") { const thinking = delta.thinking || ""; if (thinking) parts.push({ text: thinking, thought: true }); } else if (delta.type === "input_json_delta") { } return parts; })() }}',
                        role: 'model'
                      },
                      index: 0
                    }]
                  },
                  remove: ['type', 'index', 'delta', 'content_block']
                }
              },
              end: {
                body: {
                  add: {
                    candidates: [{
                      content: {
                        parts: [{ text: '' }],
                        role: 'model'
                      },
                      finishReason: '{{ (() => { const sr = body.delta?.stop_reason; if (sr === "end_turn") return "STOP"; if (sr === "max_tokens") return "MAX_TOKENS"; if (sr === "stop_sequence") return "STOP"; if (sr === "tool_use") return "STOP"; return "STOP"; })() }}',
                      index: 0
                    }],
                    usageMetadata: {
                      promptTokenCount: '{{ body.usage?.input_tokens || 0 }}',
                      candidatesTokenCount: '{{ body.delta?.usage?.output_tokens || 0 }}',
                      totalTokenCount: '{{ (body.usage?.input_tokens || 0) + (body.delta?.usage?.output_tokens || 0) }}'
                    }
                  },
                  remove: ['type', 'delta']
                }
              }
            }
          }
        },
        {
          match: { status: '^[45]..$' },
          rules: {
            default: {
              body: {
                add: {
                  error: {
                    message: '{{ body.error?.message || "Unknown error" }}',
                    code: '{{ body.error?.code }}',
                    type: '{{ body.error?.type }}'
                  }
                },
                remove: ['error']
              }
            }
          }
        }
      ]
    }
  ]
};
