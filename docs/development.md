# Development Guide

This guide covers the current monorepo workflow for Bungee.

---

## 1) Prerequisites

- Bun `>=1.0.0`
- Node.js `>=18` (for ecosystem/tooling compatibility)

---

## 2) Monorepo Structure

```text
.
├── packages/
│   ├── core/    # runtime engine
│   ├── cli/     # CLI binary
│   ├── types/   # shared TS types
│   └── ui/      # dashboard frontend
├── docs/
├── scripts/
├── config.example.json
└── docker-compose.yml
```

Package roles:

- `core`: master-worker runtime, request handling, plugin runtime, API/UI handlers
- `cli`: operational commands (`start/stop/status/logs/ui/upgrade`)
- `types`: shared contract types used by core and tooling
- `ui`: Svelte dashboard build artifacts bundled into core

---

## 3) Key Scripts

Root scripts from `package.json`:

| Script | Purpose |
|---|---|
| `bun dev` | run core in watch mode |
| `bun test` | run workspace tests |
| `bun run build` | build types + UI + bundled UI + core + CLI |
| `bun run build:full` | build + binary packaging |
| `bun run build:types` | build shared types package |
| `bun run build:ui` | build UI package |
| `bun run build:core` | build core package |
| `bun run build:cli` | build CLI package |
| `bun run build:binaries` | build standalone binaries |

---

## 4) Local Development Workflow

```bash
# 1) Install dependencies
bun install

# 2) Prepare local config
cp config.example.json config.json

# 3) Run in watch mode
bun dev

# 4) Run tests
bun test
```

Dashboard default endpoint:

```text
http://localhost:8088/__ui/
```

---

## 5) Build Pipeline Notes

Production build chain (root `build`) includes:

1. Build shared types
2. Generate widget registry
3. Build UI
4. Bundle UI assets into core
5. Build core runtime
6. Build CLI

This ensures UI and runtime artifacts are synchronized.

---

## 6) Testing Strategy

- Unit + integration tests are under `packages/core/tests`
- CLI and types packages currently have minimal/no test suites
- CI flow builds UI assets and then executes `bun test`

Recommended local pre-PR checks:

```bash
bun run build:ui
bun run bundle:ui
bun test
```

---

## 7) Contribution Conventions

- Use Conventional Commits
- Keep PRs focused and incremental
- Add/adjust tests for behavior changes
- Update docs when configuration or operational behavior changes
