import { expect, test } from 'bun:test';
import { runTestProfile, SHORT_PROFILE } from './real-proxy';
import { SCENARIO_NAMES } from './real-proxy-scenarios';

test('short real profile exercises every protocol path without exposing a quick CLI', async () => {
  const records = await runTestProfile(SHORT_PROFILE);
  expect(records).toHaveLength(SCENARIO_NAMES.length);
  expect(records.map((record) => record.scenario)).toEqual([...SCENARIO_NAMES]);
  expect(records.every((record) => record.before.report.measurement.completed >= 0 && record.after.report.measurement.completed >= 0)).toBe(true);
  const invalid = records.flatMap((record) => [
    ...(record.before.valid ? [] : [{ label: 'before', scenario: record.scenario, errors: record.before.report.correctness.error_samples }]),
    ...(record.after.valid ? [] : [{ label: 'after', scenario: record.scenario, errors: record.after.report.correctness.error_samples }]),
  ]);
  if (invalid.length > 0) console.error(`short profile invalid: ${JSON.stringify(invalid)}`);
  expect(invalid).toHaveLength(0);
}, 120_000);
