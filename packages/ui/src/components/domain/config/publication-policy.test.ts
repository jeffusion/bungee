import { expect, test } from 'bun:test';
import { DEFAULT_PUBLICATION_POLICY, MAX_PUBLICATION_TIMEOUT_MS } from '@jeffusion/bungee-types';
import { publicationInputs, parsePublicationInputs, publicationServerErrors, publicationFields } from './publication-policy';
import { configurationDiff } from './workspace';
import { publicationMessage, drainSummary } from './publication-state';
import { publicationFixture } from '../../../../tests/fixtures/publication';

test('absence shows defaults without materialising policy; explicit defaults review separately', () => {
  const before = { logical_configuration: { routes: [], services: [], plugins: [] }, plugin_activations: [] };
  expect(publicationInputs()).toEqual({ drain_start_timeout_ms: '5', drain_timeout_ms: '300', worker_exit_timeout_ms: '10' });
  expect(configurationDiff(before, structuredClone(before))).toEqual([]);
  const after = { ...before, logical_configuration: { ...before.logical_configuration, publication: DEFAULT_PUBLICATION_POLICY } };
  const diff = configurationDiff(before, after);
  expect(diff).toHaveLength(3);
  expect(diff[0]).toMatchObject({ before: 'defaultSeconds:5', after: 'seconds:5', action: 'added' });
  expect(configurationDiff(after, before)[0]).toMatchObject({ before: 'seconds:5', after: 'defaultSeconds:5', action: 'removed' });
  expect(Object.hasOwn(before.logical_configuration, 'publication')).toBe(false);
  expect(configurationDiff(before, { ...before, logical_configuration: { ...before.logical_configuration, publication: null } })[0]).toMatchObject({ label: 'publicationHidden', before: 'unset', after: 'hidden' });
});

test('raw input stays unchanged for every invalid intermediate state', () => {
  for (const field of publicationFields) for (const [raw, error] of [['', 'required'], ['0', 'positiveInteger'], ['-1', 'positiveInteger'], ['1.5', 'positiveInteger'], ['1e3', 'positiveInteger'], [' ', 'positiveInteger'], [String(MAX_PUBLICATION_TIMEOUT_MS / 1000 + 1), 'maximum']] as const) {
    const inputs = { ...publicationInputs(), [field]: raw };
    const parsed = parsePublicationInputs(inputs);
    expect(parsed.policy).toBeNull(); expect(parsed.errors[field]).toBe(error);
    expect(inputs[field]).toBe(raw);
  }
});

test('independent positive second timers accept equality, inverted relationships and safe maximum', () => {
  const parsed = parsePublicationInputs({ drain_start_timeout_ms: '900', drain_timeout_ms: '1', worker_exit_timeout_ms: String(MAX_PUBLICATION_TIMEOUT_MS / 1000) });
  expect(parsed.errors).toEqual({});
  expect(parsed.policy).toEqual({ drain_start_timeout_ms: 900000, drain_timeout_ms: 1000, worker_exit_timeout_ms: MAX_PUBLICATION_TIMEOUT_MS });
  expect(parsePublicationInputs({ drain_start_timeout_ms: '10', drain_timeout_ms: '10', worker_exit_timeout_ms: '10' }).policy).not.toBeNull();
});

test('server validation paths associate all timeout fields, never unrelated paths', () => {
  expect(publicationServerErrors([{ path: 'logical_configuration.publication.drain_timeout_ms', message: 'must be positive' }, { path: 'aggregate/logical_configuration/publication/worker_exit_timeout_ms' }])).toEqual({ drain_timeout_ms: 'server', worker_exit_timeout_ms: 'server' });
  expect(publicationServerErrors([{ path: 'publication' }])).toEqual(Object.fromEntries(publicationFields.map(f => [f, 'server'])));
  expect(publicationServerErrors([{ path: 'logical_configuration.auth.tokens' }])).toEqual({});
  expect(publicationServerErrors([{ path: 'logical_configuration.publication.drain_timeout_ms', message: 'Must be greater than zero' }])).toEqual({ drain_timeout_ms: 'positiveInteger' });
});

test('historical drain failure cannot make unconfirmed or stale serving look effective', () => {
  const p = publicationFixture({ serving_complete: true, serving_revision: 8,
    operation: { operation_id: 'op', committed_revision: 8, state: 'degraded', result_status: 202, error_code: 'old_worker_drain_failed' } });
  expect(publicationMessage(p, true)).toBe('drainFailed');
  expect(publicationMessage(p, false)).toBe('statusUnavailable');
  expect(publicationMessage({ ...p, serving_revision: 7 }, true)).toBe('drainUnconfirmed');
  expect(publicationMessage({ ...p, serving_complete: false }, true)).toBe('drainUnconfirmed');
  expect(publicationMessage({ ...p, operation: { ...p.operation!, state: 'draining', error_code: null } }, true)).toBe('draining');
});

test('actual drain control failure details retain slots and accurate failure labels', () => {
  expect(drainSummary('old_worker_drain_failed', '0:apply_failed, 1:apply_failed')).toEqual({ relevant: true, hidden: false, rows: [{ slot: 0, code: 'apply_failed' }, { slot: 1, code: 'apply_failed' }] });
});
