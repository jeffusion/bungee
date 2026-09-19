import { describe, expect, test } from 'bun:test';
import {
  compareScenario,
  compareSuite,
  mad,
  median,
  type Scenario,
} from './real-proxy-compare';

const samples = (values: readonly number[]) => ({ before: values, after: values });

function scenario(scenarioName: Scenario, before: readonly number[], after: readonly number[]) {
  return compareScenario({ scenario: scenarioName, before, after });
}

describe('real proxy comparison', () => {
  test('uses midpoint for even medians and median absolute deviation', () => {
    expect(median([1, 3, 5, 7])).toBe(4);
    expect(mad([1, 3, 5, 7])).toBe(2);
  });

  test('uses the correct ratio direction for throughput and latency', () => {
    expect(scenario('throughput', [100, 100, 100, 100, 100], [90, 90, 90, 90, 90]).verdict).toBe('regression');
    expect(scenario('latency', [100, 100, 100, 100, 100], [110, 110, 110, 110, 110]).verdict).toBe('regression');
    expect(scenario('throughput', [100, 100, 100, 100, 100], [110, 110, 110, 110, 110]).verdict).toBe('pass');
    expect(scenario('latency', [100, 100, 100, 100, 100], [90, 90, 90, 90, 90]).verdict).toBe('pass');
  });

  test('uses the floor when MAD is zero', () => {
    const result = scenario('throughput', [100, 100, 100, 100, 100], [99, 99, 99, 99, 99]);
    expect(result.sigma).toBe(0);
    expect(result.noise).toBe(0.03);
    expect(result.verdict).toBe('pass');
  });

  test('keeps the stricter cancel and publication latency policy isolated', () => {
    for (const scenarioName of ['cancel', 'publication'] as const) {
      const result = scenario(scenarioName, [100, 100, 100, 100, 100], [115, 115, 115, 115, 115]);
      expect(result.noise_floor).toBe(0.10);
      expect(result.max_noise).toBe(0.20);
      expect(result.verdict).toBe('regression');
    }
  });

  test('requires four of five regressions', () => {
    const before = [100, 100, 100, 100, 100];
    expect(scenario('throughput', before, [83, 83, 83, 101, 101]).verdict).toBe('pass');
    expect(scenario('throughput', before, [83, 83, 83, 83, 101]).verdict).toBe('regression');
  });

  test('marks excessive noise inconclusive', () => {
    const result = scenario('throughput', [100, 100, 100, 100, 100], [
      100 / Math.exp(0.1),
      100 / Math.exp(0.2),
      100 / Math.exp(0.3),
      100 / Math.exp(0.4),
      100 / Math.exp(5),
    ]);
    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toBe('noise-exceeds-maximum');
    expect(result.noise!).toBeGreaterThan(0.08);
  });

  test('distinguishes missing samples from invalid sample values', () => {
    expect(scenario('throughput', [1, 1, 1, 1], [1, 1, 1, 1]).verdict).toBe('inconclusive');
    expect(scenario('throughput', [1, 1, 1, 1, 1], [1, 1, 1, 1, 0]).verdict).toBe('invalid');
    expect(scenario('throughput', [1, 1, 1, 1, 1], [1, 1, 1, 1, Number.NaN]).verdict).toBe('invalid');
    expect(scenario('throughput', [1, 1, 1, 1, 1], [1, 1, 1, 1, Number.POSITIVE_INFINITY]).verdict).toBe('invalid');
    expect(compareScenario({ scenario: 'throughput', before: [1, 1, 1, 1, 1] }).reason).toBe('protocol-invalid');
  });

  test('keeps scenarios isolated and suite never offsets a non-pass', () => {
    const suite = compareSuite([
      { scenario: 'throughput', before: [100, 100, 100, 100, 100], after: [80, 80, 80, 80, 101] },
      { scenario: 'latency', ...samples([100, 100, 100, 100, 100]) },
    ]);
    expect(suite.verdict).toBe('regression');
    expect(suite.scenarios.map(({ verdict }) => verdict)).toEqual(['regression', 'pass']);

    const inconclusive = compareSuite([
      { scenario: 'throughput', before: [1, 1, 1, 1], after: [1, 1, 1, 1] },
      { scenario: 'latency', before: [100, 100, 100, 100, 100], after: [100, 100, 100, 100, 100] },
    ]);
    expect(inconclusive.verdict).toBe('inconclusive');

    const invalid = compareSuite([
      { scenario: 'throughput', before: [1, 1, 1, 1, 1], after: [1, 1, 1, 1, 0] },
      { scenario: 'latency', ...samples([100, 100, 100, 100, 100]) },
    ]);
    expect(invalid.verdict).toBe('invalid');
  });

  test('returns JSON-safe, stable output for invalid protocol input', () => {
    const result = compareScenario({ scenario: 'throughput', before: [1, 1, 1, 1, 1], after: [1, 1, 1, 1, 0] });
    expect(JSON.stringify(result)).not.toContain('undefined');
    expect(JSON.stringify(result)).not.toContain('NaN');
    expect(result).toEqual({
      scenario: 'throughput',
      direction: 'higher-better',
      verdict: 'invalid',
      reason: 'protocol-invalid',
      sample_count: 5,
      regression_count: 0,
      effect: null,
      sigma: null,
      noise: null,
      noise_floor: 0.03,
      max_noise: 0.08,
    });
  });
});
