import { expect, test } from 'bun:test';
import { ingressOptionsFromEnvironment, startIngressProcess, type IngressRuntimeOptions } from '../../src/ingress/runtime';
import { IngressControllerClient } from '../../src/ingress/supervision-http';
import { deriveSupervisionProcessKey, type SupervisionProcessCredential } from '../../src/supervision';

const root = new Uint8Array(32).fill(3);
const instance = '10000000-0000-4000-8000-000000000001';
const processId = '20000000-0000-4000-8000-0000000000e1';
const boot = '30000000-0000-4000-8000-0000000000e1';
const credential: SupervisionProcessCredential = deriveSupervisionProcessKey(root, instance, 'ingress', processId, boot);
const transportSecret = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url');
const authority = { controller_epoch: 1, controller_id: '40000000-0000-4000-8000-0000000000e1' } as const;

function runtimeHarness(overrides: Partial<IngressRuntimeOptions> = {}) {
  let releases = 0;
  const lock = { path: '/tmp/opencode/bungee-ingress-runtime-test.lock', release: async () => { releases += 1; } };
  return {
    releases: () => releases,
    start: () => startIngressProcess({
      instanceLockPath: lock.path,
      credential,
      transportSecret,
      publicHost: '127.0.0.1',
      publicPort: 0,
      supervisionPort: 0,
      acquireLock: async () => lock,
      ...overrides,
    }),
  };
}

test('the startup watchdog self-stops an ingress that no controller ever attaches to', async () => {
  const harness = runtimeHarness({ startupWatchdogMs: 25 });
  const handle = await harness.start();
  await Bun.sleep(90);
  expect(harness.releases()).toBe(1);
  await handle.stop();
});

test('an authenticated attach cancels the startup watchdog and lease expiry never self-stops', async () => {
  const harness = runtimeHarness({ startupWatchdogMs: 200 });
  const handle = await harness.start();
  const client = new IngressControllerClient({
    baseUrl: `http://127.0.0.1:${handle.supervisionPort}`,
    credential,
    fetch: (input, init) => fetch(input, init),
  });
  const attached = await client.attach(await client.challenge(authority), authority, 1);
  expect(attached).toMatchObject({ pid: process.pid });
  // Past the original watchdog deadline: the attach already canceled it, and the later
  // lease/attach-grace freeze path must stop nothing on its own.
  await Bun.sleep(400);
  expect(harness.releases()).toBe(0);
  await handle.stop();
  expect(harness.releases()).toBe(1);
});

test('BUNGEE_INGRESS_STARTUP_WATCHDOG_MS is a restricted positive integer', () => {
  const parse = (environment: Record<string, string | undefined>) =>
    ingressOptionsFromEnvironment(credential, 'transport-secret', environment);
  expect(parse({}).startupWatchdogMs).toBeUndefined();
  expect(parse({ BUNGEE_INGRESS_STARTUP_WATCHDOG_MS: '250' }).startupWatchdogMs).toBe(250);
  for (const value of ['0', '-1', '1.5', 'abc', ' ', '1e3', '025', '9999999999999999999999']) {
    expect(() => parse({ BUNGEE_INGRESS_STARTUP_WATCHDOG_MS: value }))
      .toThrow(/BUNGEE_INGRESS_STARTUP_WATCHDOG_MS/);
  }
});
