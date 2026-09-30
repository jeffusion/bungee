/**
 * Outer harness budgets; internal SQLite, RPC, and process deadlines stay unchanged.
 * Use the stateful budget for file-backed SQLite fixtures, including tests under unit/:
 * migration, durable writes, and cleanup share the test's total time on CI runners.
 * In mixed suites, apply it per case so memory-only and mocked tests keep the default.
 */
export const STATEFUL_INTEGRATION_TEST_TIMEOUT_MS = 30_000;
export const REAL_PROCESS_SCENARIO_TEST_TIMEOUT_MS = 90_000;
