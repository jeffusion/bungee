import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { ExpressionContext } from '../../src/expression-engine';
import type { RuntimeUpstream } from '../../src/worker/types';
import { filterByCondition } from '../../src/worker/upstream/condition-filter';
import { logger } from '../../src/logger';

const baseContext: ExpressionContext = {
  headers: { 'content-type': 'application/json' },
  body: { model: 'gpt-4', user: { tier: 'pro' } },
  url: { pathname: '/chat', search: '', host: 'api.local', protocol: 'https:' },
  method: 'POST',
  env: {},
};

const createContext = (overrides: Partial<ExpressionContext> = {}): ExpressionContext => ({
  headers: { ...baseContext.headers, ...(overrides.headers ?? {}) },
  body: { ...baseContext.body, ...(overrides.body ?? {}) },
  url: { ...baseContext.url, ...(overrides.url ?? {}) },
  method: overrides.method ?? baseContext.method,
  env: { ...baseContext.env, ...(overrides.env ?? {}) },
  ...(overrides.stream ? { stream: overrides.stream } : {}),
});

const createUpstream = (overrides: Partial<RuntimeUpstream> = {}): RuntimeUpstream => ({
  upstream_id: overrides.upstream_id ?? 'test-upstream',
  target: overrides.target ?? 'http://example.com',
  weight: overrides.weight ?? 100,
  priority: overrides.priority ?? 1,
  status: overrides.status ?? 'HEALTHY',
  consecutive_failures: overrides.consecutive_failures ?? 0,
  consecutive_successes: overrides.consecutive_successes ?? 0,
  recovery_attempt_count: overrides.recovery_attempt_count ?? 0,
  ...overrides,
});

describe('filterByCondition', () => {
  const originalWarn = logger.warn;
  const originalDebug = logger.debug;
  let warnSpy: ReturnType<typeof mock>;
  let debugSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    warnSpy = mock(() => {});
    debugSpy = mock(() => {});
    logger.warn = warnSpy as any;
    logger.debug = debugSpy as any;
  });

  afterEach(() => {
    logger.warn = originalWarn;
    logger.debug = originalDebug;
  });

  test('includes upstreams without condition', () => {
    const upstreams = [
      createUpstream({ target: 'http://no-condition' })
    ];

    const result = filterByCondition(upstreams, createContext());

    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('http://no-condition');
  });

  test('includes upstream when condition evaluates to true', () => {
    const upstreams = [
      createUpstream({
        target: 'http://matched',
        condition: "{{ body.model === 'gpt-4' }}"
      })
    ];

    const result = filterByCondition(upstreams, createContext());

    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('http://matched');
  });

  test('excludes upstream when condition evaluates to false', () => {
    const upstreams = [
      createUpstream({
        target: 'http://mismatch',
        condition: "{{ body.model === 'claude' }}"
      })
    ];

    const result = filterByCondition(upstreams, createContext());

    expect(result).toHaveLength(0);
  });

  test('excludes upstream and logs warning when condition evaluation throws', () => {
    const upstreams = [
      createUpstream({
        target: 'http://error',
        condition: '{{ invalidFunctionCall() }}'
      })
    ];

    const result = filterByCondition(upstreams, createContext());

    expect(result).toHaveLength(0);
    expect(warnSpy.mock.calls.length).toBe(1);
    const [logObject, message] = warnSpy.mock.calls[0];
    expect(logObject).toMatchObject({
      target: 'http://error',
      condition: '{{ invalidFunctionCall() }}'
    });
    expect(message).toContain('evaluation failed');
  });

  test('returns empty array when upstream list is empty', () => {
    const result = filterByCondition([], createContext());
    expect(result).toHaveLength(0);
  });

  test('handles mixed upstreams with and without conditions', () => {
    const upstreams = [
      createUpstream({ target: 'http://always-included' }),
      createUpstream({
        target: 'http://plan-match',
        condition: "{{ body.user.tier === 'pro' }}"
      }),
      createUpstream({
        target: 'http://header-mismatch',
        condition: "{{ headers['x-plan'] === 'enterprise' }}"
      })
    ];

    const context = createContext({
      headers: { ...baseContext.headers, 'x-plan': 'standard' }
    });

    const result = filterByCondition(upstreams, context);

    expect(result.map(up => up.target)).toEqual([
      'http://always-included',
      'http://plan-match'
    ]);
  });
});
