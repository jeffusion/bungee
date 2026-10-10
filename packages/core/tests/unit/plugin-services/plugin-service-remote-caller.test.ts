import { describe, expect, test } from 'bun:test';
import { HostRpcAdapter, type HostRpcOwnerInput, type HostRpcRemoteCallerHandle } from '../../../src/plugin-services/host-rpc';

const contract = { id: 'remote.echo', version: 1, methods: { echo: {
  kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['background', 'bootstrap'],
} } } as const;
const target = { provider: 'provider', service: contract.id, major: 1, method: 'echo' };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture() {
  const work = new Map<string, ReturnType<typeof gate<string>>>();
  const releases = new Map<string, number>(); let runs = 0; let authorized = true;
  const adapter = new HostRpcAdapter({ process: 'control', limits: { drainTimeoutMs: 1 }, resolvePlacement: () => null,
    resolveJournal: () => null, resolveCallee: () => null });
  const input = (plugin: string, instance: string, process: 'control' | 'worker' = 'control'): HostRpcOwnerInput => ({
    token: Object.freeze({}), plugin, scope: 'global',
    declarations: plugin === 'provider' ? { provides: [{ id: contract.id, version: 1, kind: 'rpc', process: 'control' }] }
      : { consumes: [{ plugin: 'provider', id: contract.id, version: 1, kind: 'rpc', process }] },
    dependencies: plugin === 'provider' ? {} : { provider: '*' },
    lifecycle: { endpoint: `${instance}.endpoint`, instance, generation: 1, catalog: 'remote.catalog', subject: plugin },
    getLifecycleState: () => ({ ready: true, retiring: false, revoked: false }),
    acquireLease: () => ({ release: () => { releases.set(instance, (releases.get(instance) ?? 0) + 1); } }),
    resolveInvocationContext: () => null,
  });
  const provider = adapter.createOwner(input('provider', 'provider'));
  provider.publish(contract, { echo: value => { runs += 1; return work.get(value)?.promise ?? value; } }); provider.markReady();
  const remote = (instance: string, overrides: Partial<HostRpcOwnerInput> = {}): HostRpcRemoteCallerHandle => adapter.createRemoteCaller({
    ...input('consumer', instance, 'worker'), ...overrides, process: 'worker', authorizeIncoming: () => authorized,
  });
  return { adapter, provider, input, remote, work, releases, runs: () => runs, authorize: (value: boolean) => { authorized = value; } };
}

describe('canonical host authenticated remote caller capabilities', () => {
  for (const phase of ['authorize', 'register-consumption', 'acquire-lease'] as const) {
    test(`${phase} reentrant disposal cannot issue a grant after reporting drained`, async () => {
      const made = fixture(); const base = made.input('consumer', `reentrant.${phase}`, 'worker');
      let actor!: HostRpcRemoteCallerHandle; let disposal: Promise<unknown> | undefined;
      const revoke = () => { disposal = actor.dispose(); };
      actor = made.adapter.createRemoteCaller({ ...base, process: 'worker',
        authorizeIncoming: () => { if (phase === 'authorize') revoke(); return true; },
        registerConsumption: () => { if (phase === 'register-consumption') revoke(); },
        acquireLease: request => { if (phase === 'acquire-lease') revoke(); return base.acquireLease(request); },
      });
      try {
        const call = actor.invokeTracked({ target, purpose: 'background', input: 'must-not-run' });
        await expect(call.result).rejects.toMatchObject({ code: 'unauthorized' }); await call.terminal;
        expect(await disposal).toEqual({ drained: true, active: 0 }); expect(made.runs()).toBe(0); expect(made.adapter.status().active).toBe(0);
        expect(made.releases.get(`reentrant.${phase}`) ?? 0).toBe(phase === 'authorize' ? 0 : 1);
        expect(made.releases.get('provider') ?? 0).toBe(phase === 'authorize' ? 0 : 1);
        const again = actor.invokeTracked({ target, purpose: 'background', input: 'still-denied' });
        await expect(again.result).rejects.toMatchObject({ code: 'unauthorized' }); await again.terminal;
      } finally { await actor.dispose(); await made.provider.dispose(); await made.adapter.dispose(); }
    });
  }

  test('imports worker consumers into a control provider without creating an SDK facade or duplicate logical owner', async () => {
    const made = fixture(); const local = made.adapter.createOwner(made.input('consumer', 'local'));
    const a = made.remote('worker.a'); const b = made.remote('worker.b');
    try {
      local.markReady();
      expect(Object.keys(a).sort()).toEqual(['dispose', 'invokeTracked']);
      const first = a.invokeTracked({ target, purpose: 'background', input: 'a' });
      const second = b.invokeTracked({ target, purpose: 'background', input: 'b' });
      expect(await first.result).toBe('a'); expect(await second.result).toBe('b'); await Promise.all([first.terminal, second.terminal]);
      expect(await local.consume('provider', contract).echo('local')).toBe('local');
      await a.dispose();
      expect(await local.consume('provider', contract).echo('still-local')).toBe('still-local');
      const live = b.invokeTracked({ target, purpose: 'background', input: 'still-b' }); expect(await live.result).toBe('still-b'); await live.terminal;
      expect(made.releases.get('worker.a')).toBe(1); expect(made.releases.get('worker.b')).toBe(2);
    } finally { await a.dispose(); await b.dispose(); await local.dispose(); await made.provider.dispose(); await made.adapter.dispose(); }
  });

  test('broker authorization is mandatory on every invocation and cannot be bypassed by input identity fields', async () => {
    const made = fixture(); const actor = made.remote('worker.a');
    try {
      made.authorize(false);
      const rejected = actor.invokeTracked({ target, purpose: 'background', input: 'secret', caller: { subject: 'provider' }, callerToken: {} } as never);
      await expect(rejected.result).rejects.toMatchObject({ code: 'unauthorized' }); await rejected.terminal;
      expect(made.runs()).toBe(0); expect(made.releases.size).toBe(0);
      made.authorize(true);
      const allowed = actor.invokeTracked({ target, purpose: 'background', input: 'ok' }); expect(await allowed.result).toBe('ok'); await allowed.terminal;
      made.authorize(false);
      const revoked = actor.invokeTracked({ target, purpose: 'background', input: 'late' }); await expect(revoked.result).rejects.toMatchObject({ code: 'unauthorized' }); await revoked.terminal;
      expect(made.runs()).toBe(1);
    } finally { await actor.dispose(); await made.provider.dispose(); await made.adapter.dispose(); }
  });

  test('each remote origin revokes and drains only its own actual task and preserves other worker and local calls', async () => {
    const made = fixture(); const local = made.adapter.createOwner(made.input('consumer', 'local'));
    const a = made.remote('worker.a'); const b = made.remote('worker.b');
    for (const key of ['a', 'b', 'local']) made.work.set(key, gate<string>());
    try {
      local.markReady();
      const first = a.invokeTracked({ target, purpose: 'background', input: 'a' }); const rejected = first.result.catch(error => error);
      const second = b.invokeTracked({ target, purpose: 'background', input: 'b' });
      const third = local.consume('provider', contract).echo('local');
      expect(await a.dispose()).toEqual({ drained: false, active: 1 }); expect(await rejected).toMatchObject({ code: 'revoked' });
      const afterDispose = a.invokeTracked({ target, purpose: 'background', input: 'must-not-start' });
      await expect(afterDispose.result).rejects.toMatchObject({ code: 'unauthorized' }); await afterDispose.terminal;
      expect(made.runs()).toBe(3);
      expect(made.adapter.status().active).toBe(3); expect(made.releases.size).toBe(0);
      made.work.get('a')!.resolve('late-a'); await first.terminal;
      expect(await a.dispose()).toEqual({ drained: true, active: 0 });
      expect(made.adapter.status().active).toBe(2); expect(made.releases.get('worker.a')).toBe(1);
      made.work.get('b')!.resolve('b'); made.work.get('local')!.resolve('local');
      expect(await second.result).toBe('b'); expect(await third).toBe('local'); await second.terminal;
      const next = b.invokeTracked({ target, purpose: 'background', input: 'new-b' }); expect(await next.result).toBe('new-b'); await next.terminal;
    } finally {
      for (const [key, work] of made.work) work.resolve(key);
      await a.dispose(); await b.dispose(); await local.dispose(); await made.provider.dispose(); await made.adapter.dispose();
    }
  });

  test('remote consumption and dependency declarations still gate authorization', async () => {
    const made = fixture();
    const wrongProcess = made.remote('wrong.process', { declarations: { consumes: [{ plugin: 'provider', id: contract.id, version: 1, kind: 'rpc', process: 'control' }] } });
    const missingDependency = made.remote('missing.dependency', { dependencies: {} });
    try {
      for (const actor of [wrongProcess, missingDependency]) {
        const call = actor.invokeTracked({ target, purpose: 'background', input: 'denied' }); await expect(call.result).rejects.toMatchObject({ code: 'unauthorized' }); await call.terminal;
      }
      expect(made.runs()).toBe(0); expect(made.releases.size).toBe(0);
    } finally { await wrongProcess.dispose(); await missingDependency.dispose(); await made.provider.dispose(); await made.adapter.dispose(); }
  });
});
