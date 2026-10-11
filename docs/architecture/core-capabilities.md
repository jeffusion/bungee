# Core Capabilities

This document explains Bungee's core traffic-processing capabilities and how they compose at runtime.

---

## 1) Layered Rule Composition

Bungee applies rules through layered scopes:

1. Global and route plugins
2. Selected service plugins
3. Selected upstream plugins

This model enables global defaults with target-specific overrides.

---

## 2) Expression Engine

Bungee supports expression-based values in configuration using `{{ ... }}`.

Common context variables:

- `headers`
- `body`
- `url`
- `method`
- `env`

Example:

```json
{
  "headers": {
    "add": {
      "X-Request-ID": "{{ uuid() }}",
      "X-Method": "{{ method }}"
    }
  },
  "body": {
    "default": {
      "processed_at": "{{ new Date().toISOString() }}"
    }
  }
}
```

---

## 3) Request Snapshot Isolation

Before upstream attempts, runtime creates a request snapshot. This prevents cross-attempt state pollution during failover retries and preserves deterministic plugin behavior.

Practical effect:

- Each retry starts from an equivalent baseline request state.
- Transformations from failed attempts are not leaked into subsequent attempts.

---

## 4) Failover and Conditional Upstreams

Upstream selection supports:

- priority groups (lower priority value first)
- weighted distribution within a group
- condition-based filtering (`condition` expression)
- disabled upstream exclusion

`FailoverCoordinator` iterates candidates until success or exhaustion.

---

## 5) Plugin-Driven Processing

Plugins can operate at global, route, service and upstream scopes.

Runtime responsibilities include:

- plugin discovery/metadata management
- scoped execution graph initialization
- precompiled hook dispatch for request path efficiency

See also:

- [Plugin System](../reference/plugin-api.md)
- [Plugin Development](../guides/plugin-development.md)

---

## 6) Streaming Transformation

Streaming and non-streaming responses are both supported in plugin hooks.

- Non-streaming: response-level transformation hooks
- Streaming: chunk-level processing and flush behavior

This design supports provider protocol adaptation and chunk-shape transformations.

For provider-specific conversion contracts, see [AI Provider Conversion](../reference/ai-protocol-conversion.md).
