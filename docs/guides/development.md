# Development Guide

This guide covers the current monorepo workflow for Bungee.

---

## 1) Prerequisites

- Bun `1.4.2` (the version fixed by the project, Docker and CI)
- Node.js `>=18` (for ecosystem/tooling compatibility)

---

## 2) Monorepo Structure

```text
.
├── packages/
│   ├── core/    # runtime engine
│   ├── cli/     # CLI binary
│   ├── llms/    # protocol conversion facade
│   ├── types/   # shared TS types
│   └── ui/      # dashboard frontend
├── docs/
├── scripts/
└── docker-compose.yml
```

Package roles:

- `core`: master-worker runtime, request handling, plugin runtime, API/UI handlers
- `cli`: operational commands (`start/stop/status/logs/ui/upgrade`)
- `llms`: reusable protocol conversion and public plugin facade
- `types`: shared contract types used by core and tooling
- `ui`: Svelte dashboard build artifacts bundled into core

---

## 3) Key Scripts

Root scripts from `package.json`:

| Script | Purpose |
|---|---|
| `bun dev` | run core in watch mode |
| `bun test` | run workspace tests |
| `bun run build` | check architecture + build types + llms + widgets + UI + bundled UI + core + CLI |
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

# 2) Initialize isolated storage, then run in watch mode
bun packages/core/src/main.ts --initialize-config /tmp/bungee-dev/data/bungee.db
BUNGEE_CONFIG_DB_PATH=/tmp/bungee-dev/data/bungee.db BUNGEE_ACCESS_DB_PATH=/tmp/bungee-dev/logs/access.db bun run dev

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

1. Run architecture checks
2. Build shared types and llms
3. Generate widget registry
4. Build UI and bundle its assets into core
5. Build core, storage Worker entries and external plugins
6. Build CLI

This ensures UI and runtime artifacts are synchronized.

---

## 6) Testing Strategy

- Unit + integration tests are under `packages/core/tests`
- Package-local tests cover CLI, UI and reusable conversion code; root `tests/` contains cross-process integration, browser and benchmark entry points
- CI flow builds UI assets and then executes `bun test`

### CI and releases

Development branches submit PRs directly to `main`. CI runs only on pull
requests targeting `main`, including subsequent updates to those PRs.
The Linux and macOS test jobs must pass before a PR can merge into `main`,
and its branch must be up to date with `main`. Windows CI is temporarily
disabled: its matrix entry, process-regression step and release-check entry
are kept commented out for restoration.

A push to `main` starts Release directly, without rerunning the test matrix.
Before publishing, Release verifies that the pushed commit is the final commit
of a merged PR targeting `main`, that its latest PR CI run and both Linux/macOS
test jobs succeeded, and that the release Git tree matches the tree recorded by
that CI run. Comparing trees supports rebase merges even when commit SHAs
change. A missing or expired `tested-pr` artifact blocks publication; rerun
the PR CI before retrying Release. Artifacts are retained for 14 days.

Keep the required checks `test (ubuntu-latest)` and `test (macos-latest)` bound
to GitHub Actions, with strict status checks enabled. Do not require
`test (windows-latest)` while the Windows job is disabled. The current
administrator bypass is needed by `GH_TOKEN` for
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
- UI and plugin UI changes must follow [component ownership and style isolation](../../packages/ui/docs/INDUSTRIAL_DESIGN_SYSTEM.md#347-mandatory-component-ownership-and-style-isolation): extract repeated DOM into shared components and keep component CSS scoped. Ad hoc global styles are forbidden; any genuine exception needs a documented reason, narrow scope, explicit review and browser verification. `bun test packages/ui/src/style-scope.test.ts` enforces the frozen global-style baseline in normal CI.

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

The `kernel-monotonic-v1:` deadline identity binds the clock domain. Processes
must agree on this domain and boot identity before interpreting deadlines.
A failed domain/boot match retains worker ownership instead of inventing an exit
proof or restarting the deadline.

## Tool locations and execution

Run commands from the repository root unless a tool specifies otherwise. Permanent tools live under `scripts/`; package-only tooling stays in its package.

| Location | Entry | Inputs, outputs and side effects |
| --- | --- | --- |
| `scripts/build/` | Root build commands | Sources/manifests → dist, generated widgets, bundled UI and binary archives; overwrites generated artifacts |
| `scripts/checks/` | `bun run check:architecture` | Source AST → diagnostics and nonzero exit on violations; no product writes |
| `scripts/runtime/` | Docker entrypoint and health check | Container environment → process launch or management-readiness exit status |
| `scripts/release/` | `version:sync`, `publish:dry`, `publish`, `release:binaries` | Version, registry/GitHub credentials and artifacts → version changes or external publication; publishing needs authorization |
| `tests/browser/` | Browser entry points below | Isolated server/fixtures → assertions, screenshots and diagnostic output |
| `tests/benchmarks/` | Body resource measurement | Synthetic payloads → resource/latency metrics; no production data |

`generate-favicons.ts` also requires `rsvg-convert` and regenerates `packages/ui/public` icon assets. `version:sync <version>` writes root and workspace package metadata. Binary upload requires an explicit release tag and credentials; consult its argument validation before use. Browser tools require Playwright Chromium (`bunx playwright install chromium`). Temporary diagnostics and evidence belong outside versioned source.

The release tool resolves the repository root from its own location. `--dry-run` still performs a full build, but packs into a temporary directory outside the project, removes that directory on exit, and restores package.json. It preserves existing repository tarballs. Binary upload failures during manual publishing return a nonzero exit code; packages already published to npm remain published. Follow the error message to retry the upload after fixing the failure.

### UI smoke

Start the UI development server in another terminal, then run the fixture-backed check:

```bash
cd packages/ui
bun run dev --host 127.0.0.1 --port 5173
```

```bash
bun run test:ui:smoke --base-url http://127.0.0.1:5173 --strict-testids --evidence-dir /tmp/bungee-ui-smoke
```

The smoke tool mocks management APIs and checks rendered routes, login, page errors and screenshots. It proves UI behavior under fixtures; it does not prove production authentication or provider connectivity. The default output is ignored `test-results/ui-smoke`; `UI_SMOKE_EVIDENCE_DIR` can override it.

### Built runtime and storage

After `bun run build`, validate isolated JS and native artifacts separately:

```bash
bun tests/browser/storage-acceptance-playwright.ts
bun tests/browser/storage-acceptance-playwright.ts --binary /absolute/path/to/bungee-linux
```

The tool creates private temporary storage and a local upstream, verifies management login, an actual proxy response, restart and session recovery, then checks cleanup. Failure retains its fixture for diagnosis; never supply production data as test input. Passing the JS run does not establish native or other-platform acceptance.

`bun tests/browser/plugin-business-browser-acceptance.ts --evidence-dir /tmp/bungee-plugin-browser` exercises plugin management with an isolated runtime and controlled upstream; it also downloads the public models.dev catalog, so it needs network access. It does not call paid model providers. Package-local browser checks remain under `packages/ui/tests/`, including NumberInput, scrolling, route editors and dashboard ownership. Use their documented environment inputs rather than personal ports or directories. All browser evidence must distinguish fixtures from real provider calls.
