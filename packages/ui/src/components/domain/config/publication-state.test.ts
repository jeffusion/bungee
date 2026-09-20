import { expect, test } from 'bun:test';
import { retainAccepted, forgetDispatch, submissionLocked, isTerminal, queryFailure, replacementSummary, drainSummary } from './publication-state';
import { readPendingPublication, pendingPublicationKey } from './workspace';
import { preCommitRejection } from './publication-state';
import { ApiError } from '../../../api/client';

test('pre-commit summary only renders exact codes and allowlisted reason data properties', () => {
  for (const code of ['control_recovering', 'control_readiness_failed']) {
    for (const reason of [undefined, null, {}, ['lease_margin'], 'SECRET', 'lease_margin\nSECRET', 'lease_margin', 'admission_recovering']) {
      const error = new ApiError(503, { error: code, reason, message: 'SECRET', stack: 'SECRET', aggregate: 'SECRET', token: 'SECRET' }, 'SECRET');
      const result = preCommitRejection(error, false);
      expect(result?.summary).toBe(`HTTP 503 · ${code}${typeof reason === 'string' && ['lease_margin', 'admission_recovering'].includes(reason) ? ` · ${reason}` : ''}`);
      expect(preCommitRejection(error, true)).toBeNull();
    }
  }
  for (const body of [null, [], 'control_recovering', { error: 'control_recovering ' }, Object.create({ error: 'control_recovering' }), { get error() { throw new Error('must not read'); } }]) {
    expect(preCommitRejection(new ApiError(503, body, 'SECRET'), false)).toBeNull();
  }
  for (const status of [500, 502, 504, 401, 409, 422]) expect(preCommitRejection(new ApiError(status, { error: 'control_recovering' }, 'SECRET'), false)).toBeNull();
  expect(preCommitRejection(new Error('SECRET'), false)).toBeNull();
});

const id = '10000000-0000-4000-8000-000000000001';
test('accepted metadata roundtrips only the version, identity and acceptance', () => {
  let value = '';
  expect(retainAccepted(id, { setItem(key, v) { expect(key).toBe(pendingPublicationKey); value = v; } })).toBe(true);
  expect(JSON.parse(value)).toEqual({ version: 1, mutationId: id, accepted: true });
  expect(readPendingPublication({ getItem: () => value })).toEqual({ mutationId: id, accepted: true });
});
test('storage set failure warns without throwing or invalidating acceptance', () => {
  expect(retainAccepted(id, { setItem() { throw new Error('denied'); } })).toBe(false);
});
test('terminal outcome survives local remove failure', () => {
  expect(forgetDispatch({ removeItem() { throw new Error('denied'); } })).toBe(false);
  for (const state of ['degraded', 'converged']) expect(isTerminal(state)).toBe(true);
  expect(submissionLocked('terminal')).toBe(false); expect(submissionLocked('rejected')).toBe(false);
  expect(submissionLocked('unknown')).toBe(true); expect(submissionLocked('active')).toBe(true);
});
test('query 404, unauthorized and network are distinct and do not authorize a resend', () => {
  expect(queryFailure(404)).toBe('queryNotFound'); expect(queryFailure(401)).toBe('queryUnauthorized');
  expect(queryFailure(403)).toBe('queryUnauthorized'); expect(queryFailure(503)).toBe('queryNetwork');
});
test('replacement slots/attempts/revisions are bounded; raw errors are excluded', () => {
  const result = replacementSummary([{ worker_slot: 1, attempt_no: 2, applied_revision: 42, state: 'failed', last_error: 'SECRET' }, { worker_slot: 'SECRET', attempt_no: -1, applied_revision: NaN, state: 'SECRET' }]);
  expect(result[0]).toEqual({ slot: 1, attempt: 2, revision: 42, state: 'failed' });
  expect(result[1]).toEqual({ slot: null, attempt: null, revision: null, state: 'unknown' });
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
test('only the entire allowlisted drain grammar is rendered', () => {
  expect(drainSummary('old_worker_drain_failed', '0:timeout, 1:exit-unconfirmed').rows).toEqual([{ slot: 0, code: 'timeout' }, { slot: 1, code: 'exit_unconfirmed' }]);
  for (const detail of ['SECRET', '0:timeout, 1:SECRET', '9:timeout\nSECRET', '0:timeout'.repeat(100)]) {
    const result = drainSummary('old_worker_drain_failed', detail);
    expect(result.hidden).toBe(true); expect(result.rows).toEqual([]); expect(JSON.stringify(result)).not.toContain('SECRET');
  }
});
