import { expect, test } from 'bun:test';
import { exactExitProof, isExactServingTarget } from '../../src/master-runtime/runtime-evidence';

const HASH = `sha256:${'a'.repeat(64)}`;
const CATALOG = `sha256:${'b'.repeat(64)}`;
const snapshot = { revision: 4, content_hash: HASH, aggregate: {} } as never;

function worker(slot: number, overrides: Record<string, unknown> = {}): any {
  const process = {
    slot, pid: 7000 + slot,
    identity: { master_generation: '50000000-0000-4000-8000-000000000001', worker_instance_id: `60000000-0000-4000-8000-${String(slot + 1).padStart(12, '0')}`, worker_slot: slot },
  };
  return { process, revision: 4, content_hash: HASH, plugin_catalog_hash: CATALOG, private_port: 4100 + slot, publication: null, ...overrides };
}

test('isExactServingTarget rejects every hostile target dimension', () => {
  const admitted = [worker(0), worker(1)];
  const pool = { owns: (process: unknown) => process === admitted[0].process || process === admitted[1].process } as never;
  expect(isExactServingTarget(admitted, admitted, snapshot, CATALOG, 2, pool)).toBe(true);
  const hostile = [
    [worker(0, { revision: 3 }), worker(1)],
    [worker(0, { content_hash: `sha256:${'c'.repeat(64)}` }), worker(1)],
    [worker(0, { plugin_catalog_hash: `sha256:${'c'.repeat(64)}` }), worker(1)],
    [worker(0), worker(0)],
    [worker(0)],
    [worker(2), worker(1)],
    [worker(0, { process: { ...worker(0).process, identity: { ...worker(0).process.identity, worker_slot: 1 } } }), worker(1)],
    [worker(0), { ...worker(1), process: { ...worker(1).process, pid: 9999 } }],
  ];
  for (const evidence of hostile) expect(isExactServingTarget(admitted, evidence, snapshot, CATALOG, 2, pool)).toBe(false);
});

function exitResult(pid: number, proved: boolean, overrides: Record<string, unknown> = {}): any {
  return { process: { pid }, exitEvidence: proved ? { exited: true, pid } : null, ...overrides };
}

test('exactExitProof consumes duplicate PIDs as a multiset with one proof per owned object', () => {
  // Two owned objects share a PID and each carries its own proof: convergence holds.
  expect(exactExitProof([99, 99], [exitResult(99, true), exitResult(99, true)])).toBe(true);
  // One of the duplicate-PID objects lacks proof: convergence fails.
  expect(exactExitProof([99, 99], [exitResult(99, true), exitResult(99, false)])).toBe(false);
  // A result went missing even though every reported PID matched.
  expect(exactExitProof([99, 99], [exitResult(99, true)])).toBe(false);
  // A foreign process's proof never satisfies an expected PID slot.
  expect(exactExitProof([99, 99], [exitResult(99, true), exitResult(98, true)])).toBe(false);
  // A wait error voids that object's proof even when the evidence itself matches.
  expect(exactExitProof([99], [exitResult(99, true, { waitError: new Error('unverified') })])).toBe(false);
  // Baseline single-PID behaviour is unchanged.
  expect(exactExitProof([99], [exitResult(99, true)])).toBe(true);
  expect(exactExitProof([99], [])).toBe(false);
});
