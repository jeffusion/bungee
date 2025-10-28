# Plugin System

Bungee features a powerful, TypeScript-first plugin system that enables extensible request/response transformations with full type safety and IDE support.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Available Plugins](#available-plugins)
- [Writing Custom Plugins](#writing-custom-plugins)
- [Plugin API Reference](#plugin-api-reference)
- [Testing Plugins](#testing-plugins)
- [Security: URL Protection Mechanism](#security-url-protection-mechanism)
- [Best Practices](#best-practices)

---

## Overview

The Plugin system provides a modular, code-based approach to extending Bungee's functionality:

```
config.json → Plugin Registry → Individual Plugins → Request/Response Processing
```

### Key Features

| Feature | Description |
|---------|-------------|
| **Type Safety** | Full TypeScript interfaces with IntelliSense support |
| **Debugging** | Clear, readable code with standard debugging tools |
| **Testing** | Unit testable with built-in test utilities |
| **Maintainability** | Modular plugins (200-400 lines each) |
| **Extensibility** | Easy to add new features and capabilities |

---

## Configuration

### Route-Level Plugins

Apply plugins to all requests matching a route:

```json
{
  "routes": [{
    "path": "/v1/chat/completions",
    "plugins": ["openai-to-anthropic"],
    "upstreams": [{
      "target": "https://api.anthropic.com"
    }]
  }]
}
```

### Upstream-Level Plugins

Apply plugins to specific upstreams:

```json
{
  "routes": [{
    "path": "/api/ai",
    "plugins": ["anthropic-to-openai"],
    "upstreams": [
      {
        "target": "https://api.openai.com",
        "priority": 1
      },
      {
        "target": "https://api.gemini.com",
        "priority": 2,
        "plugins": ["anthropic-to-gemini"]
      }
    ]
  }]
}
```

### Plugin Loading

Bungee automatically loads plugins from:

1. **Built-in plugins**: `packages/core/src/plugins/transformers/*.plugin.ts`
2. **Custom plugins**: Specified by path in configuration

```json
{
  "plugins": [
    {
      "path": "./custom-plugins/my-plugin.ts",
      "enabled": true,
      "options": {
        "customOption": "value"
      }
    }
  ]
}
```

---

## Available Plugins

Bungee includes 6 built-in transformer plugins for API format conversion:

| Plugin | Description |
|--------|-------------|
| `openai-to-anthropic` | Convert OpenAI format → Claude API |
| `anthropic-to-openai` | Convert Claude API → OpenAI format |
| `anthropic-to-gemini` | Convert Claude API → Gemini format |
| `gemini-to-anthropic` | Convert Gemini format → Claude API |
| `openai-to-gemini` | Convert OpenAI format → Gemini format |
| `gemini-to-openai` | Convert Gemini format → OpenAI format |

### Feature Support

All transformer plugins support:

- ✅ Request transformation (path, headers, body)
- ✅ Response transformation (non-streaming)
- ✅ SSE streaming transformation
- ✅ Tool calls / Function calling
- ✅ Multi-modal content (images)
- ✅ Thinking tags support
- ✅ Error handling

---

## Writing Custom Plugins

### Plugin Interface

```typescript
interface Plugin {
  // Required
  name: string;

  // Optional metadata
  version?: string;

  // Lifecycle hooks
  onRequestInit?(ctx: PluginContext): Promise<void>;
  onBeforeRequest?(ctx: PluginContext): Promise<void>;
  onInterceptRequest?(ctx: PluginContext): Promise<Response | null>;
  onResponse?(ctx: PluginContext & { response: Response }): Promise<Response | void>;
  onError?(ctx: PluginContext & { error: Error }): Promise<void>;
  onDestroy?(): Promise<void>;

  // Streaming hooks
  processStreamChunk?(chunk: any, ctx: StreamChunkContext): Promise<any[] | null>;
  flushStream?(ctx: StreamChunkContext): Promise<any[]>;
}
```

### Simple Example: Header Transformer

```typescript
import type { Plugin, PluginContext } from '../plugin.types';

export default class CustomHeaderPlugin implements Plugin {
  name = 'custom-header-transformer';
  version = '1.0.0';

  async onBeforeRequest(ctx: PluginContext): Promise<void> {
    // Add custom headers
    ctx.headers['X-Custom-Header'] = 'my-value';
    ctx.headers['X-Timestamp'] = String(Date.now());

    // Modify body
    if (ctx.body && typeof ctx.body === 'object') {
      ctx.body.customField = 'custom-value';
    }
  }
}
```

### Stream Transformer Example

```typescript
import type { Plugin, StreamChunkContext } from '../plugin.types';

export default class CustomStreamPlugin implements Plugin {
  name = 'custom-stream-transformer';

  async processStreamChunk(
    chunk: any,
    ctx: StreamChunkContext
  ): Promise<any[] | null> {
    // Transform the chunk
    const transformed = {
      ...chunk,
      customField: 'added-by-plugin',
      chunkNumber: ctx.chunkIndex
    };

    // Return as array (supports N:M transformations)
    return [transformed];
  }

  async flushStream(ctx: StreamChunkContext): Promise<any[]> {
    // Output any buffered data
    return [];
  }
}
```

### N:M Stream Transformation

The `processStreamChunk` hook supports flexible input/output ratios:

```typescript
async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[] | null> {
  // 1:0 - Buffer the chunk (don't output yet)
  if (shouldBuffer(chunk)) {
    ctx.streamState.set('buffered', chunk);
    return [];
  }

  // 1:1 - Simple transformation
  if (isSimpleCase(chunk)) {
    return [transform(chunk)];
  }

  // 1:M - Split into multiple chunks
  if (shouldSplit(chunk)) {
    return [
      transformPart1(chunk),
      transformPart2(chunk)
    ];
  }

  // N:M - Combine with buffered chunks
  const buffered = ctx.streamState.get('buffered');
  if (buffered) {
    ctx.streamState.delete('buffered');
    return [combine(buffered, chunk)];
  }

  // null - Pass through unchanged
  return null;
}
```

---

## Plugin API Reference

### PluginContext

Available in all request hooks:

```typescript
interface PluginContext {
  // Request information
  method: string;

  /**
   * Protected URL object
   * Plugins can READ all fields but can only MODIFY:
   * - pathname (e.g., '/v1/messages')
   * - search (e.g., '?foo=bar')
   * - hash (e.g., '#section')
   *
   * READONLY fields (cannot be modified):
   * - protocol, host, hostname, port, origin, href
   */
  url: PluginUrl;

  headers: Record<string, string>;
  body?: any;

  // Route configuration
  route: RouteConfig;
  upstream: Upstream;

  // Request metadata
  requestId: string;
}

interface PluginUrl {
  // Modifiable fields (whitelist)
  pathname: string;  // Plugin can modify
  search: string;    // Plugin can modify
  hash: string;      // Plugin can modify

  // Readonly fields (cannot modify)
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly href: string;
  readonly origin: string;
}
```

### StreamChunkContext

Available in streaming hooks:

```typescript
interface StreamChunkContext extends PluginContext {
  chunkIndex: number;
  streamState: Map<string, any>;  // For buffering/state management
}
```

### Lifecycle Hooks

| Hook | When Called | Purpose |
|------|-------------|---------|
| `onRequestInit` | Before any processing | Initialize plugin state |
| `onBeforeRequest` | Before forwarding request | Modify request |
| `onInterceptRequest` | Before forwarding | Return custom response |
| `onResponse` | After receiving response | Transform non-streaming response |
| `processStreamChunk` | For each SSE chunk | Transform streaming data |
| `flushStream` | End of stream | Output buffered data |
| `onError` | On request error | Handle errors |
| `onDestroy` | Plugin cleanup | Release resources |

### Response Transformation

The `onResponse` hook must return a new Response object:

```typescript
async onResponse(ctx: PluginContext & { response: Response }): Promise<Response | void> {
  const contentType = ctx.response.headers.get('content-type') || '';

  // Only process JSON responses
  if (!contentType.includes('application/json')) {
    return; // Pass through
  }

  // Clone before reading body (Response can only be read once)
  const responseClone = ctx.response.clone();
  const body = await responseClone.json();

  // Transform the body
  const transformed = this.transformBody(body);

  // Return new Response
  return new Response(JSON.stringify(transformed), {
    status: ctx.response.status,
    statusText: ctx.response.statusText,
    headers: ctx.response.headers
  });
}
```

**Important**:
- Must return `Promise<Response | void>`
- Return `void` to pass through unchanged
- Return `Response` to replace original
- Always `clone()` before reading body

---

## Testing Plugins

### Unit Tests

```typescript
import { describe, expect, test } from 'bun:test';
import MyPlugin from './my-plugin';

describe('MyPlugin', () => {
  const plugin = new MyPlugin();

  test('should transform request headers', async () => {
    const ctx = {
      method: 'POST',
      headers: {},
      body: { test: true }
    };

    await plugin.onBeforeRequest(ctx);

    expect(ctx.headers['X-Custom-Header']).toBe('my-value');
  });

  test('should transform response body', async () => {
    const response = new Response(
      JSON.stringify({ original: 'data' }),
      { headers: { 'content-type': 'application/json' } }
    );

    const ctx = { response };
    const result = await plugin.onResponse(ctx);

    const transformed = await result.json();
    expect(transformed).toHaveProperty('transformedField');
  });
});
```

### Integration Tests

```typescript
test('plugin should work end-to-end', async () => {
  const config = {
    routes: [{
      path: '/test',
      plugins: ['my-plugin'],
      upstreams: [{ target: 'http://localhost:9000' }]
    }]
  };

  const server = await startTestServer(config);

  const response = await fetch('http://localhost:8088/test', {
    method: 'POST',
    body: JSON.stringify({ test: true })
  });

  const data = await response.json();
  expect(data).toMatchSnapshot();

  await server.stop();
});
```

---

## Security: URL Protection Mechanism

### Overview

Bungee implements a **dual-layer protection mechanism** to prevent plugins from modifying critical URL fields (like `host` or `protocol`), ensuring request isolation between upstreams.

### Why It Matters

Without protection, a plugin could accidentally (or maliciously) change the request destination:

```typescript
// ❌ DANGEROUS (blocked by protection)
ctx.url.host = 'evil.com';  // Would redirect request to wrong server
ctx.url.protocol = 'http:';  // Would downgrade to insecure connection
```

This could cause:
- **Request leakage**: Requests meant for upstream A being sent to upstream B
- **Security breaches**: Sensitive data sent to unauthorized servers
- **Failover corruption**: Retry logic sending requests to wrong upstreams

### Protection Layers

#### 1. Compile-Time Protection (TypeScript)

The `PluginUrl` interface uses `readonly` modifiers:

```typescript
interface PluginUrl {
  // ✅ Allowed: Plugins can modify these
  pathname: string;
  search: string;
  hash: string;

  // ❌ Blocked: TypeScript compiler prevents modification
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly href: string;
  readonly origin: string;
}
```

**Result**: IDE shows error immediately when trying to modify readonly fields.

#### 2. Runtime Protection (Proxy)

Even if TypeScript checks are bypassed, JavaScript Proxy intercepts modifications:

```typescript
// Attempt to modify host
ctx.url.host = 'evil.com';

// Console warning:
// [PluginUrl] Attempt to modify readonly field "host" (blocked for security)

// Value remains unchanged
console.log(ctx.url.host); // Still 'api.example.com'
```

**Result**: Modifications are logged and blocked at runtime.

### What Plugins Can Do

Plugins have full read access to all URL fields:

```typescript
async onBeforeRequest(ctx: PluginContext): Promise<void> {
  // ✅ READ all fields (for decision logic)
  if (ctx.url.host === 'api.openai.com') {
    // Your logic here
  }

  console.log(ctx.url.protocol); // 'https:'
  console.log(ctx.url.pathname); // '/v1/chat/completions'

  // ✅ MODIFY whitelisted fields
  ctx.url.pathname = '/v1/messages';
  ctx.url.search = '?stream=true';
  ctx.url.hash = '#section';

  // ❌ CANNOT modify readonly fields
  // TypeScript error + Runtime block
  ctx.url.host = 'evil.com';
}
```

### Whitelist: Modifiable Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `pathname` | `string` | URL path | `/v1/messages` |
| `search` | `string` | Query string | `?foo=bar` |
| `hash` | `string` | URL fragment | `#section` |

### Blacklist: Readonly Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `protocol` | `readonly string` | URL protocol | `https:` |
| `host` | `readonly string` | Host + port | `api.example.com:443` |
| `hostname` | `readonly string` | Host only | `api.example.com` |
| `port` | `readonly string` | Port number | `443` |
| `href` | `readonly string` | Complete URL | `https://api.example.com/path` |
| `origin` | `readonly string` | Protocol + host | `https://api.example.com` |

### Example: Path Transformation Plugin

```typescript
export class OpenAIToAnthropicPlugin implements Plugin {
  name = 'openai-to-anthropic';

  async onBeforeRequest(ctx: PluginContext): Promise<void> {
    // ✅ Read pathname to check format
    if (ctx.url.pathname === '/v1/chat/completions') {
      // ✅ Modify pathname (whitelisted)
      ctx.url.pathname = '/v1/messages';

      // ✅ Host remains unchanged automatically
      // Request will still go to the configured upstream
    }

    // Transform body...
    const body = ctx.body as any;
    // ...
  }
}
```

### Testing URL Protection

You can verify the protection mechanism:

```typescript
test('should block host modification', () => {
  const url = new URL('https://api.example.com/v1/messages');
  const pluginUrl = createPluginUrl(url);

  // Attempt to modify host
  const result = Reflect.set(pluginUrl, 'host', 'evil.com');

  // Verification
  expect(result).toBe(false);  // Modification blocked
  expect(pluginUrl.host).toBe('api.example.com');  // Value unchanged
});
```

See `packages/core/tests/unit/plugin-url-security.test.ts` for complete test suite (24 tests covering all scenarios).

---

## Best Practices

### 1. Keep Plugins Focused

Each plugin should do one thing well:

✅ **Good**: `openai-to-anthropic` - converts one format to another
❌ **Bad**: `multi-format-converter` - tries to handle all formats

### 2. Use TypeScript Types

Leverage TypeScript for better development experience:

```typescript
interface OpenAIRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

interface AnthropicRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
}
```

### 3. Handle Errors Gracefully

```typescript
async onResponse(ctx: PluginContext & { response: Response }): Promise<Response | void> {
  try {
    const body = await ctx.response.clone().json();
    return new Response(JSON.stringify(transform(body)));
  } catch (error) {
    // Log error but don't break the proxy
    console.error('Plugin transformation failed:', error);
    return; // Pass through original response
  }
}
```

### 4. Clone Responses Before Reading

Always clone before reading the body:

```typescript
// ✅ Correct
const responseClone = ctx.response.clone();
const body = await responseClone.json();

// ❌ Wrong - consumes the original response
const body = await ctx.response.json();
```

### 5. Use Stream State for Buffering

For stateful stream transformations:

```typescript
async processStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<any[]> {
  // Store state
  const buffer = ctx.streamState.get('buffer') || [];
  buffer.push(chunk);
  ctx.streamState.set('buffer', buffer);

  // Process when ready
  if (isComplete(buffer)) {
    ctx.streamState.delete('buffer');
    return [combineChunks(buffer)];
  }

  return [];
}
```

### 6. Document Configuration Options

If your plugin accepts options:

```typescript
interface MyPluginOptions {
  /** Maximum retries for failed transformations */
  maxRetries?: number;
  /** Enable debug logging */
  debug?: boolean;
}

export default class MyPlugin implements Plugin {
  name = 'my-plugin';

  constructor(private options: MyPluginOptions = {}) {
    this.options.maxRetries = options.maxRetries ?? 3;
    this.options.debug = options.debug ?? false;
  }
}
```

### 7. Respect URL Modification Limits

Only modify whitelisted URL fields to ensure request isolation:

```typescript
// ✅ Correct: Modify pathname and search
async onBeforeRequest(ctx: PluginContext): Promise<void> {
  if (ctx.url.pathname === '/v1/chat/completions') {
    ctx.url.pathname = '/v1/messages';
  }

  // Add stream parameter
  ctx.url.search = '?stream=true';
}

// ❌ Wrong: Never modify host or protocol
async onBeforeRequest(ctx: PluginContext): Promise<void> {
  ctx.url.host = 'api.anthropic.com';  // TypeScript error + Runtime block
  ctx.url.protocol = 'https:';          // TypeScript error + Runtime block
}
```

**Why this matters**:
- Plugins should transform request format, not redirect to different servers
- Upstream selection is handled by the routing layer
- Modifying host breaks request isolation and failover logic
- The protection mechanism will block such attempts automatically

---

## Reference Implementation

For complete examples, see the built-in transformer plugins:

- `packages/core/src/plugins/transformers/openai-to-anthropic.plugin.ts`
- `packages/core/src/plugins/transformers/anthropic-to-gemini.plugin.ts`
- `packages/core/src/plugins/transformers/gemini-to-openai.plugin.ts`

These implementations demonstrate:
- Full bidirectional API format conversion
- Streaming transformation
- Error handling
- Tool calling support
- Multi-modal content handling

---

## Further Reading

- [Plugin Registry Implementation](../packages/core/src/plugin-registry.ts)
- [Plugin Type Definitions](../packages/core/src/plugin.types.ts)
- [Stream Executor](../packages/core/src/stream-executor.ts)
- [Test Examples](../packages/core/tests/plugin-registry.test.ts)
