# Documentation Index

This directory contains the technical documentation for Bungee.

---

## Getting Started

- [Configuration Guide](./configuration.md)
- [Core Capabilities](./core-capabilities.md)
- [Architecture](./architecture.md)
- [Web Dashboard](./dashboard.md)
- [Authentication And Optional Plugins](./authentication.md)

---

## Operations

- [CLI Reference](./cli.md)
- [Deployment (Docker)](./deployment.md)
- [Development Guide](./development.md)
- [Performance Benchmark](./performance.md)

---

## Advanced Extensions

- [Plugin System](./plugin-system.md)
- [Plugin Development](./plugin-development.md)
- [AI Provider Conversion](./ai-provider-conversion.md)
- [LLM 协议适配器](./llm-protocol-adapter.md)

---

## Authentication Architecture

- [Plugin Extension Architecture Design](./plugin-extension-architecture.md) — dependency resolution, plugin services, generic read-only resources, persistent guards and durable state.
- [Authentication And Access Control Design](./authentication-authorization-design.md) — anonymous defaults, optional single-administrator authentication, plugin-owned Keys, route protection, rate limits and token budgets.

- [Implementation Verification](./authentication-implementation.md) — current verified tests and outstanding acceptance work.

---

## Documentation Principles

- **Progressive disclosure**: top-level README stays concise; deep details live in `docs/`.
- **Code-aligned content**: behavior descriptions should match current implementation in `packages/*`.
- **Operational clarity**: commands and examples should be directly runnable.
