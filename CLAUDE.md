# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bungee is a high-performance reverse proxy server built with Bun and TypeScript. It features hot configuration reloading, multi-process architecture (master-worker model), dynamic request/response transformation, and a modern web dashboard.

## Documentation

For detailed understanding, refer to these docs:

| Document | Description |
|----------|-------------|
| [docs/plugin-system.md](docs/plugin-system.md) | Plugin architecture, hooks, contributions, SDK, and build system |
| [docs/plugin-development.md](docs/plugin-development.md) | Step-by-step plugin development guide with examples |
| [docs/ai-provider-conversion.md](docs/ai-provider-conversion.md) | AI API format conversion specs (OpenAI/Anthropic/Gemini) |
| [README.md](README.md) | Project overview, features, quick start, and configuration |

## Build & Development Commands

```bash
# Development
bun dev                    # Start with hot-reload (watch mode)
bun start                  # Start in production mode

# Build
bun run build              # Full build: types → ui → bundle → core → cli
bun run build:core         # Build core package (includes plugins)
bun run build:ui           # Build UI dashboard
bun run build:clean        # Clean all build artifacts

# Testing
bun test                   # Run all tests
bun test <file>            # Run specific test file
bun test packages/core/tests/expression-engine.test.ts  # Example

# Publish
bun run publish:dry        # Dry-run publish
bun run publish            # Publish to npm
```

## Architecture

### Monorepo Structure

- **packages/core** - Core reverse proxy engine (master/worker processes, routing, plugins)
- **packages/ui** - Svelte + DaisyUI web dashboard
- **packages/cli** - Standalone CLI with daemon management
- **packages/types** - Shared TypeScript types
- **plugins/** - External plugins (high-cohesion structure: server + ui in same directory)

### Master-Worker Model

- `master.ts` - Manages worker lifecycle, config watching, database migrations, graceful shutdowns
- `worker.ts` - HTTP request handling, plugin initialization, routing logic

### Plugin System (Two Registries)

1. **PluginRegistry** (`plugin-registry.ts`) - Discovery and metadata management
   - Scans plugin directories
   - Manages plugin enabled/disabled state in SQLite
   - Loads plugin classes

2. **ScopedPluginRegistry** (`scoped-plugin-registry.ts`) - Runtime execution
   - Creates PluginHandler instances per scope (global/route/upstream)
   - Precompiles hooks at startup for O(1) request-time lookup
   - Manages plugin lifecycle

### Hooks System

Located in `packages/core/src/hooks/`:

- `onRequest` - Modify incoming requests
- `onResponse` - Transform responses
- `onStreamChunk` - Process SSE streaming chunks
- `onError` / `onFinally` - Error handling and cleanup

### Key Files

| File | Purpose |
|------|---------|
| `config.ts` | Configuration loading with env override support |
| `expression-engine.ts` | Dynamic `{{ }}` expression evaluation |
| `stream-executor.ts` | Plugin streaming transformation engine |
| `worker/request/handler.ts` | Main request routing logic |
| `worker/upstream/selector.ts` | Load balancing and upstream selection |
| `api/router.ts` | Admin API routing |

## External Plugin Structure

Plugins in `plugins/` follow high-cohesion structure:

```plaintext
plugins/token-stats/
├── server/index.ts      # Backend (hooks, API handlers)
└── ui/Component.svelte  # Frontend (optional, native Svelte)
```

Backend plugins must export a class with:

- `static readonly name` - Plugin identifier
- `static readonly metadata` - Contributes (api, nativeWidgets)
- `static readonly translations` - i18n strings
- `register(hooks)` method - Hook registration

## Testing Patterns

Tests use `bun:test`. Key test files:

- `expression-engine.test.ts` - Expression evaluation
- `stream-executor.test.ts` - Streaming plugin execution
- `ai-transformer/*.test.ts` - API format conversion tests
- `unit/failover.test.ts` - Upstream failover logic

## Configuration

- Config file: `config.json` (auto-created on first run)
- Database: `logs/access.db` (SQLite - stats, plugin storage)
- Environment variables override config.json values

## Commit Convention

Uses [Conventional Commits](https://www.conventionalcommits.org/) with commitlint. Example:

```text
feat(plugins): add token statistics plugin
fix(core): resolve streaming timeout issue
```
