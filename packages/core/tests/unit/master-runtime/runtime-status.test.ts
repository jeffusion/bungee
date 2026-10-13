import { expect, test } from 'bun:test';
import { publicationCleanup } from '../../../src/master-runtime/runtime-status';
import type { PublicationRetirement } from '../../../src/config-storage/retirement-store';

test('typed cleanup keeps exit and cleanup independent and exposes no process proof', () => {
  const retirement = { state: 'stopped', reason_code: 'exit_unknown', members: [
    { identity: { worker_slot: 0, worker_instance_id: 'a' }, start_deadline_ns: '100', deadline_boot_id: 'boot', guard: { secret_path: 'SECRET' } },
    { identity: { worker_slot: 1, worker_instance_id: 'b' }, start_deadline_ns: '100', deadline_boot_id: 'boot' },
    { identity: { worker_slot: 2, worker_instance_id: 'c' }, start_deadline_ns: '100', deadline_boot_id: 'other' },
  ], evidence: [
    { member_id: 'a', exit_state: 'confirmed', cleanup_state: 'failed', exit_boot_id: 'boot', exit_deadline_ns: '200' },
    { member_id: 'b', exit_state: 'live', cleanup_state: 'success', exit_boot_id: 'boot', exit_deadline_ns: '200' },
    { member_id: 'c', exit_state: 'unknown', cleanup_state: 'unknown', exit_boot_id: null, exit_deadline_ns: null },
  ] } as unknown as PublicationRetirement;
  const result = publicationCleanup(retirement, (boot, deadline) => boot === 'boot' && deadline === '200' ? 123 : null)!;
  expect(result).toMatchObject({ active: true, pending_count: 1, exit_unknown_count: 1, failed_count: 1, unknown_count: 1, remaining_ms: null });
  expect(result.members[0]).toEqual({ slot: 0, exit_state: 'confirmed', cleanup_state: 'failed', remaining_ms: null });
  expect(result.members[1].remaining_ms).toBe(123);
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(publicationCleanup({ ...retirement, state: 'released' })?.active).toBe(false);
  expect(publicationCleanup(null)).toBeNull();
});

test('remaining deadline comes only from the matching clock observation', () => {
  const retirement = { state: 'pending', reason_code: null,
    members: [{ identity: { worker_slot: 0, worker_instance_id: 'a' }, start_deadline_ns: '100', deadline_boot_id: 'boot' }],
    evidence: [{ member_id: 'a', exit_state: 'live', cleanup_state: 'unknown', exit_boot_id: null, exit_deadline_ns: null }],
  } as unknown as PublicationRetirement;
  expect(publicationCleanup(retirement, () => 0)?.remaining_ms).toBe(0);
  expect(publicationCleanup(retirement, () => 250)?.remaining_ms).toBe(250);
  expect(publicationCleanup(retirement, () => -1)?.remaining_ms).toBeNull();
  expect(publicationCleanup(retirement, () => Infinity)?.remaining_ms).toBeNull();
});
