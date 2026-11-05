import { expect, test } from 'bun:test';
import { retainAccepted, forgetDispatch, submissionLocked, isTerminal, queryFailure, publicationMessage, historicalDrainFailure, runtimeHealthFault } from '../../../../../src/components/domain/config/publication-state';
import { readPendingPublication, pendingPublicationKey } from '../../../../../src/components/domain/config/workspace';
import { preCommitRejection } from '../../../../../src/components/domain/config/publication-state';
import { ApiError } from '../../../../../src/api/client';

test('pre-commit summary only renders exact codes and allowlisted reason data properties', () => {
  for (const code of ['control_recovering', 'control_readiness_failed']) {
    for (const reason of [undefined, null, {}, ['lease_margin'], 'SECRET', 'lease_margin\nSECRET', 'lease_margin', 'admission_recovering']) {
      const error = new ApiError(503, { error: code, reason, message: 'SECRET', stack: 'SECRET', aggregate: 'SECRET', token: 'SECRET' }, 'SECRET');
      const result = preCommitRejection(error, false);
      expect(result).not.toBeNull();
      expect(result?.summary).toContain(code);
      expect(result?.summary).not.toContain('SECRET');
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
  for (const state of ['degraded', 'converged', 'superseded']) expect(isTerminal(state)).toBe(true);
  expect(submissionLocked('terminal')).toBe(false); expect(submissionLocked('rejected')).toBe(false);
  expect(submissionLocked('active')).toBe(false);
  expect(submissionLocked('unknown')).toBe(true);
});
test('publication message separates pending, superseded history and cleanup faults', () => {
  const base = (operation: unknown, cleanup: unknown = null) => ({ operation, cleanup, serving_complete: true, serving_revision: 8, target_revision: 8 }) as any;
  // A newer desired target is still pending; the superseded record is history.
  expect(publicationMessage({ ...base({ state: 'superseded', result_status: 409, error_code: 'revision_superseded', committed_revision: 8 }), target_revision: 9 }, true)).toBe('pending');
  expect(publicationMessage(base({ state: 'superseded', result_status: 409, error_code: 'revision_superseded' }), true)).toBe('superseded');
  expect(publicationMessage(base({ state: 'superseded', result_status: 409, error_code: 'revision_superseded' },
    { active: false, state: 'stopped', failed_count: 0, unknown_count: 0, exit_unknown_count: 0 }), true)).toBe('supersededFailed');
});
test('query 404, unauthorized and network are distinct and do not authorize a resend', () => {
  expect(queryFailure(404)).toBe('queryNotFound'); expect(queryFailure(401)).toBe('queryUnauthorized');
  expect(queryFailure(403)).toBe('queryUnauthorized'); expect(queryFailure(503)).toBe('queryNetwork');
});
test('historical drain failure requires fresh confirmed serving and no active cleanup', () => {
  const publication = { operation: { state: 'degraded', error_code: 'old_worker_drain_failed' }, serving_complete: true, serving_revision: 8, target_revision: 8, cleanup: null } as any;
  expect(publicationMessage(publication, true)).toBe('historicalDrainFailure');
  expect(historicalDrainFailure(publication, true)).toBe(true);
  expect(publicationMessage(publication, false)).toBe('statusUnavailable');
  expect(publicationMessage({ ...publication, serving_revision: 7 }, true)).toBe('drainUnconfirmed');
  expect(publicationMessage({ ...publication, cleanup: { active: true, state: 'stopped' } }, true)).toBe('drainFailed');
});
test('component and dependency faults remain current even after serving converges', () => {
  const health = { observed_at: 1, component_recovery: [{ state: 'stopped' }], dependencies: [{ state: 'ready', observed_at: 1 }] } as any;
  expect(runtimeHealthFault(health, true)).toBe(true);
  expect(runtimeHealthFault(health, false)).toBe(false);
  expect(runtimeHealthFault({ ...health, component_recovery: [], dependencies: [{ state: 'ready', observed_at: null }] }, true)).toBe(true);
  expect(runtimeHealthFault({ ...health, component_recovery: [], dependencies: [{ state: 'ready', fresh: false, observed_at: 1 }] }, true)).toBe(true);
  expect(runtimeHealthFault({ ...health, component_recovery: [], dependencies: [{ state: 'ready', fresh: true, observed_at: 1 }] }, true)).toBe(false);
});
