export type Scenario =
  | 'throughput' | 'latency' | 'cancel' | 'publication'
  | 'ordinary' | 'sse' | 'large-request' | 'large-response' | 'keepalive' | 'client-cancel';
export type Direction = 'higher-better' | 'lower-better';
export type Verdict = 'pass' | 'regression' | 'inconclusive' | 'invalid';
export type ComparisonReason = 'protocol-invalid' | 'insufficient-samples' | 'noise-exceeds-maximum';

export type ScenarioInput = {
  readonly scenario: Scenario;
  readonly before: readonly number[];
  readonly after: readonly number[];
};

export type ScenarioComparison = {
  readonly scenario: Scenario | null;
  readonly direction: Direction | null;
  readonly verdict: Verdict;
  readonly reason: ComparisonReason | null;
  readonly sample_count: number;
  readonly regression_count: number;
  readonly effect: number | null;
  readonly sigma: number | null;
  readonly noise: number | null;
  readonly noise_floor: number | null;
  readonly max_noise: number | null;
};

export type SuiteComparison = {
  readonly verdict: Verdict;
  readonly reason: ComparisonReason | null;
  readonly scenarios: readonly ScenarioComparison[];
};

type ScenarioPolicy = {
  readonly direction: Direction;
  readonly noiseFloor: number;
  readonly maxNoise: number;
};

export const SCENARIO_POLICIES: Readonly<Record<Scenario, ScenarioPolicy>> = {
  throughput: { direction: 'higher-better', noiseFloor: 0.03, maxNoise: 0.08 },
  latency: { direction: 'lower-better', noiseFloor: 0.05, maxNoise: 0.12 },
  cancel: { direction: 'lower-better', noiseFloor: 0.10, maxNoise: 0.20 },
  publication: { direction: 'lower-better', noiseFloor: 0.10, maxNoise: 0.20 },
  ordinary: { direction: 'higher-better', noiseFloor: 0.03, maxNoise: 0.08 },
  sse: { direction: 'lower-better', noiseFloor: 0.05, maxNoise: 0.12 },
  'large-request': { direction: 'higher-better', noiseFloor: 0.03, maxNoise: 0.08 },
  'large-response': { direction: 'higher-better', noiseFloor: 0.03, maxNoise: 0.08 },
  keepalive: { direction: 'higher-better', noiseFloor: 0.03, maxNoise: 0.08 },
  'client-cancel': { direction: 'lower-better', noiseFloor: 0.10, maxNoise: 0.20 },
};

const SAMPLE_COUNT = 5;
const MAD_SCALE = 1.4826;
const NOISE_SCALE = 2.5;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return sorted[middle - 1]! / 2 + sorted[middle]! / 2;
}

export function mad(values: readonly number[], center = median(values)): number {
  return median(values.map((value) => Math.abs(value - center)));
}

function invalidResult(
  scenario: Scenario | null,
  direction: Direction | null,
  reason: ComparisonReason,
  sampleCount = 0,
  noiseFloor: number | null = null,
  maxNoise: number | null = null,
): ScenarioComparison {
  return {
    scenario,
    direction,
    verdict: reason === 'insufficient-samples' || reason === 'noise-exceeds-maximum' ? 'inconclusive' : 'invalid',
    reason,
    sample_count: sampleCount,
    regression_count: 0,
    effect: null,
    sigma: null,
    noise: null,
    noise_floor: noiseFloor,
    max_noise: maxNoise,
  };
}

function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && Object.hasOwn(SCENARIO_POLICIES, value);
}

export function compareScenario(input: unknown): ScenarioComparison {
  if (typeof input !== 'object' || input === null) return invalidResult(null, null, 'protocol-invalid');

  const candidate = input as Partial<ScenarioInput>;
  if (!isScenario(candidate.scenario)) return invalidResult(null, null, 'protocol-invalid');
  const policy = SCENARIO_POLICIES[candidate.scenario];
  const before = candidate.before;
  const after = candidate.after;
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return invalidResult(candidate.scenario, policy.direction, 'protocol-invalid', 0, policy.noiseFloor, policy.maxNoise);
  }
  if (before.length !== after.length || before.length > SAMPLE_COUNT || after.length > SAMPLE_COUNT) {
    return invalidResult(candidate.scenario, policy.direction, 'protocol-invalid', Math.min(before.length, after.length), policy.noiseFloor, policy.maxNoise);
  }
  if (before.length < SAMPLE_COUNT) {
    return invalidResult(candidate.scenario, policy.direction, 'insufficient-samples', before.length, policy.noiseFloor, policy.maxNoise);
  }

  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const beforeValue = before[index];
    const afterValue = after[index];
    if (beforeValue === undefined || afterValue === undefined) {
      return invalidResult(candidate.scenario, policy.direction, 'insufficient-samples', index, policy.noiseFloor, policy.maxNoise);
    }
    if (
      typeof beforeValue !== 'number' || !Number.isFinite(beforeValue) || beforeValue <= 0
      || typeof afterValue !== 'number' || !Number.isFinite(afterValue) || afterValue <= 0
    ) {
      return invalidResult(candidate.scenario, policy.direction, 'protocol-invalid', SAMPLE_COUNT, policy.noiseFloor, policy.maxNoise);
    }
  }

  const effects = before.map((beforeValue, index) => {
    const afterValue = after[index]!;
    return policy.direction === 'higher-better'
      ? Math.log(beforeValue / afterValue)
      : Math.log(afterValue / beforeValue);
  });
  if (effects.some((value) => !Number.isFinite(value))) {
    return invalidResult(candidate.scenario, policy.direction, 'protocol-invalid', SAMPLE_COUNT, policy.noiseFloor, policy.maxNoise);
  }

  const effect = median(effects);
  const sigma = MAD_SCALE * mad(effects, effect);
  const calculatedNoise = Math.exp(NOISE_SCALE * sigma) - 1;
  if (!Number.isFinite(effect) || !Number.isFinite(sigma) || !Number.isFinite(calculatedNoise)) {
    return invalidResult(candidate.scenario, policy.direction, 'protocol-invalid', SAMPLE_COUNT, policy.noiseFloor, policy.maxNoise);
  }
  const noise = Math.max(policy.noiseFloor, calculatedNoise);
  if (noise > policy.maxNoise) {
    return {
      scenario: candidate.scenario,
      direction: policy.direction,
      verdict: 'inconclusive',
      reason: 'noise-exceeds-maximum',
      sample_count: SAMPLE_COUNT,
      regression_count: effects.filter((value) => value > 0).length,
      effect,
      sigma,
      noise,
      noise_floor: policy.noiseFloor,
      max_noise: policy.maxNoise,
    };
  }

  return {
    scenario: candidate.scenario,
    direction: policy.direction,
    verdict: effect > noise && effects.filter((value) => value > 0).length >= 4 ? 'regression' : 'pass',
    reason: null,
    sample_count: SAMPLE_COUNT,
    regression_count: effects.filter((value) => value > 0).length,
    effect,
    sigma,
    noise,
    noise_floor: policy.noiseFloor,
    max_noise: policy.maxNoise,
  };
}

export function compareSuite(inputs: readonly unknown[]): SuiteComparison {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { verdict: 'invalid', reason: 'protocol-invalid', scenarios: [] };
  }

  const scenarios = inputs.map(compareScenario);
  const verdict = scenarios.reduce<Verdict>((current, result) => {
    const priority: Record<Verdict, number> = { pass: 0, regression: 1, inconclusive: 2, invalid: 3 };
    return priority[result.verdict] > priority[current] ? result.verdict : current;
  }, 'pass');
  return {
    verdict,
    reason: verdict === 'pass' ? null : scenarios.find((result) => result.verdict === verdict)?.reason ?? null,
    scenarios,
  };
}
