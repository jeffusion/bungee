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
  const invalid = records.flatMap((record) => [
    ...(record.before.valid ? [] : [{ label: 'before', scenario: record.scenario, errors: record.before.report.correctness.error_samples }]),
    ...(record.after.valid ? [] : [{ label: 'after', scenario: record.scenario, errors: record.after.report.correctness.error_samples }]),
  ]);
  if (invalid.length > 0) console.error(`short profile invalid: ${JSON.stringify(invalid)}`);
  expect(invalid).toHaveLength(0);
}, process.platform === 'linux' ? 300_000 : 120_000);
