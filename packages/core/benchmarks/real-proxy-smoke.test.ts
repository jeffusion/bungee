import { expect, test } from 'bun:test';
import { runTestProfile, SHORT_PROFILE } from './real-proxy';
import { SCENARIO_NAMES } from './real-proxy-scenarios';

test('real process protocol smoke uses the full suite on Linux and client cancellation elsewhere', async () => {
  const profile = process.platform === 'linux'
    ? SHORT_PROFILE
    : { ...SHORT_PROFILE, scenarios: ['client-cancel'] as const };
  const scenarios = profile.scenarios ?? SCENARIO_NAMES;
  const records = await runTestProfile(profile);
  expect(records).toHaveLength(scenarios.length * 2);
  expect([...new Set(records.map((record) => record.scenario))]).toEqual([...scenarios]);
  expect(records.every((record) => record.leg === 'AB' || record.leg === 'BA')).toBe(true);
  const upstreamInstances = records.flatMap((record) => [record.before.upstream_instance_id, record.after.upstream_instance_id]);
  expect(new Set(upstreamInstances).size).toBe(upstreamInstances.length);
  expect(records.every((record) => record.before.upstream_port > 0 && record.after.upstream_port > 0)).toBe(true);
  expect(records.every((record) => record.before.report.measurement.completed >= 0 && record.after.report.measurement.completed >= 0)).toBe(true);
  const cancellations = records.filter((record) => record.scenario === 'client-cancel');
  expect(cancellations.flatMap((record) => [record.before.report, record.after.report]).every((report) =>
    report.valid
    && report.details.client_rejected === true
    && report.details.upstream_cancelled === true
    && report.details.upstream_avoided === false
    && report.details.observation_completed === true
    && report.details.cancel_initiated === true
    && report.details.cancelled === true
    && report.details.timed_out === false
    && report.details.outcome === 'cancelled'
    && typeof report.details.final_requests === 'number'
    && typeof report.details.final_aborted === 'number'
    && report.details.final_requests === report.details.final_aborted
    && report.details.final_requests > 0,
  )).toBe(true);
  const invalid = records.flatMap((record) => [
    ...(record.before.valid ? [] : [{
      label: 'before', scenario: record.scenario, errors: record.before.report.correctness.error_samples,
      details: record.scenario === 'client-cancel' ? {
        established: record.before.report.details.established, cancel_initiated: record.before.report.details.cancel_initiated,
        cancelled: record.before.report.details.cancelled, timed_out: record.before.report.details.timed_out,
        outcome: record.before.report.details.outcome,
        final_requests: record.before.report.details.final_requests, final_aborted: record.before.report.details.final_aborted,
        client_rejected: record.before.report.details.client_rejected, upstream_cancelled: record.before.report.details.upstream_cancelled,
        upstream_avoided: record.before.report.details.upstream_avoided, observation_completed: record.before.report.details.observation_completed,
      } : undefined,
    }]),
    ...(record.after.valid ? [] : [{
      label: 'after', scenario: record.scenario, errors: record.after.report.correctness.error_samples,
      details: record.scenario === 'client-cancel' ? {
        established: record.after.report.details.established, cancel_initiated: record.after.report.details.cancel_initiated,
        cancelled: record.after.report.details.cancelled, timed_out: record.after.report.details.timed_out,
        outcome: record.after.report.details.outcome,
        final_requests: record.after.report.details.final_requests, final_aborted: record.after.report.details.final_aborted,
        client_rejected: record.after.report.details.client_rejected, upstream_cancelled: record.after.report.details.upstream_cancelled,
        upstream_avoided: record.after.report.details.upstream_avoided, observation_completed: record.after.report.details.observation_completed,
      } : undefined,
    }]),
  ]);
  if (invalid.length > 0) console.error(`short profile invalid: ${JSON.stringify(invalid)}`);
  expect(invalid).toHaveLength(0);
}, process.platform === 'linux' ? 300_000 : 120_000);
