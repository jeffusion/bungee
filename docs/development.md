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

# 2) Run in watch mode (creates data/bungee.db)
bun dev

# 3) Run tests
bun test
```

Dashboard default endpoint:

```text
http://localhost:8089/
```

The public listener at `0.0.0.0:8088` is proxy-only. The management API is
under `/api`, plugin static assets under `/plugins`, and health under
`/health`. The design page is `http://localhost:8089/#/design`.

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

### CI and releases

Development branches submit PRs directly to `main`. CI runs only on pull
requests targeting `main`, including subsequent updates to those PRs.
The Linux, macOS, and Windows test jobs must all pass before a PR can merge
into `main`, and its branch must be up to date with `main`.

A push to `main` starts Release directly, without rerunning the test matrix.
Before publishing, Release verifies that the pushed commit is the final commit
of a merged PR targeting `main`, that its latest PR CI run and all three test
jobs succeeded, and that the release Git tree matches the tree recorded by
that CI run. Comparing trees supports rebase merges even when commit SHAs
change. A missing or expired `tested-pr` artifact blocks publication; rerun
the PR CI before retrying Release. Artifacts are retained for 14 days.

Keep the required checks `test (ubuntu-latest)`, `test (macos-latest)`, and
`test (windows-latest)` bound to GitHub Actions, with strict status checks
enabled. The current administrator bypass is needed by `GH_TOKEN` for
semantic-release to commit package versions and `CHANGELOG.md`; the release
verification above also applies when an administrator bypasses merge rules.
Release metadata commits include `[skip ci]` to avoid triggering another run.
Release also serializes publishing and checks that remote `main` still points
to the selected commit before invoking semantic-release.

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

### Investigating intermittent shutdown failures

The runtime emits `Shutdown step failed` at the failing operation before errors
are aggregated. Its `shutdown` object includes the cleanup `stage`, elapsed time,
and a bounded, redacted error chain with the original error codes and stack.
Worker shutdown failures report expected/confirmed counts and up to 16
unconfirmed PIDs. Exit probes distinguish `exact`, `unknown`, `threw`, and
`not_run`, retain whether an identity was captured, and report the probe count.
Ingress evidence also includes the shutdown command outcome, probe timeout, and
whether that deadline was reached. A `process_identity_probe` record retains
underlying OS/query errors before they become an `unknown` result.

When the canonical lifecycle test fails, its CI output includes
`shutdownDiagnostics`, the child's PID/exit code/signal, and `windowStatus`.
Diagnostics are read from that child's frozen app and daemon log windows and
filtered by `reporterPid` to exclude a competing process sharing an app log; the
last 16 recognized records are included, with `shutdownDiagnosticsTruncated`
when older records were omitted. `truncated` or `unavailable` means the
captured evidence is incomplete. Do not infer a runtime or test-framework root
cause from an empty diagnostic list or from one successful retry.

Fault-injection tests verify evidence extraction and redaction even when the
intermittent failure cannot be reproduced. Diagnostic logging does not change
shutdown deadlines, retries, cleanup order, or the required exit proof.

### Cross-process publication deadlines

Drain-start (C) and worker-exit (E) deadlines use a shared kernel clock, not Bun's
process-relative `process.hrtime.bigint()`. Linux uses `CLOCK_BOOTTIME`, macOS uses
`CLOCK_MONOTONIC_RAW`, and Windows uses `QueryPerformanceCounter`; suspend time
consumes these windows. The system-library bindings initialize before controller
or worker admission and fail closed if unavailable.

The `kernel-monotonic-v1:` prefix on deadline boot identities distinguishes this
clock domain from legacy descriptors. Mixed versions must not interpret each
other's deadlines: shut down the old master and its workers before upgrading.
A failed domain/boot match retains worker ownership instead of inventing an exit
proof or restarting the deadline.
