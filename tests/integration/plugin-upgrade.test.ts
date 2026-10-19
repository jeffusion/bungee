import { expect, test } from 'bun:test';
import { ConfigRepository } from '../../packages/core/src/config-storage';
import {
  cleanupGatewayFixture, createGatewayFixture, releasePortBlock, requestJson,
  reservePortBlock, startTrackedGatewayMaster, stopOwnedMaster, waitForHealth,
  type GatewayMasterStartupState, type PortLease,
} from '../helpers/gateway-runtime';

test('a removed authentication plugin does not prevent dashboard and proxy startup after upgrade', async () => {
  const fixture = await createGatewayFixture({ prefix: 'plugin-upgrade', plugins: ['user-auth'] });
  const startup: GatewayMasterStartupState = { attempted: false, errors: [] };
  let lease: PortLease | undefined;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let shutdownVerified = false, portsVerifiedClosed = false;
  try {
    lease = await reservePortBlock();
    upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('upgraded-proxy') });
    const repository = ConfigRepository.open(fixture.configDbPath);
    try {
      const result = repository.commit({ mutation_id: 'before-upgrade', expected_revision: 1, kind: 'config',
        created_at: Date.now(), target_worker_slots: [], aggregate: {
          plugin_activations: [{ plugin_name: 'local-accounts' }, { plugin_name: 'removed-plugin' }],
          logical_configuration: { plugins: [{ id: '40000000-0000-4000-8000-000000000001',
            position: 1, name: 'local-accounts', enabled: true }], services: [], routes: [{
            id: '30000000-0000-4000-8000-000000000001', position: 1, path: '/proxy', plugins: [],
            endpoints: [{ id: '20000000-0000-4000-8000-000000000001', position: 1,
              target: `http://127.0.0.1:${upstream.port}`, plugins: [] }],
          }] },
        } });
      expect(result.kind).toBe('committed');
      repository.beginPublication('before-upgrade', Date.now());
      repository.markDraining('before-upgrade', Date.now());
      repository.finalizePublication('before-upgrade', { outcome: 'converged', old_workers_exited: true }, Date.now());
    } finally { repository.close(); }

    const master = await startTrackedGatewayMaster(startup, fixture, lease);
    await waitForHealth(master, lease.base, fixture);
    const management = `http://127.0.0.1:${lease.base}`;
    const page = await fetch(management);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect((await requestJson(`${management}/health/data`, {}, fixture)).response.status).toBe(200);
    const config = await requestJson(`${management}/api/config`, {}, fixture);
    expect(config.response.status).toBe(200);
    expect(config.text).not.toContain('local-accounts');
    expect(config.text).not.toContain('removed-plugin');
    const response = await fetch(`http://127.0.0.1:${lease.block.ports[1]}/proxy`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upgraded-proxy');
    await stopOwnedMaster(master); shutdownVerified = true;
  } finally {
    const errors: unknown[] = [];
    if (startup.master && !shutdownVerified) {
      try { await stopOwnedMaster(startup.master); shutdownVerified = true; } catch (error) { errors.push(error); }
    }
    if (lease) try { await releasePortBlock(lease); portsVerifiedClosed = true; } catch (error) { errors.push(error); }
    try { await upstream?.stop(true); } catch (error) { errors.push(error); }
    const removed = await cleanupGatewayFixture(fixture, {
      startupAttempted: startup.attempted, master: startup.master, shutdownVerified, portsVerifiedClosed,
    });
    if (!removed) errors.push(new Error(`upgrade fixture cleanup lacks shutdown proof: ${fixture.root}`));
    if (errors.length) throw new AggregateError(errors, 'upgrade fixture cleanup failed');
  }
}, 60_000);
