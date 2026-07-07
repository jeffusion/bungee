import { describe, it, expect } from 'bun:test';
import { FailoverCoordinator } from '../../src/worker/upstream/failover-coordinator';
import { runtimeState } from '../../src/worker/state/runtime-state';
import type { EffectiveRouteConfig, RuntimeUpstream } from '../../src/worker/types';
import type { ExpressionContext } from '../../src/expression-engine';

function createMockUpstream(overrides: Partial<RuntimeUpstream> = {}): RuntimeUpstream {
  const upstream_id = overrides.upstream_id ?? (typeof overrides.target === 'string' ? overrides.target : 'upstream-default');

  return {
    target: 'http://example.com',
    weight: 100,
    priority: 1,
    is_disabled: false,
    status: 'HEALTHY',
    consecutive_failures: 0,
    consecutive_successes: 0,
    recovery_attempt_count: 0,
    ...overrides,
    upstream_id
  };
}

function createMockRoute(overrides: Partial<EffectiveRouteConfig> = {}): EffectiveRouteConfig {
  return {
    path: '/test',
    endpoints: [],
    failover: {
      enabled: true,
      retry_on: [502, 503, 504],
      slow_start: {
        enabled: false
      }
    },
    ...overrides
  };
}

describe('FailoverCoordinator', () => {
  it('should initialize with endpoints', () => {
    const endpoints = [
      createMockUpstream({ target: 'http://s1.com', status: 'HEALTHY' }),
      createMockUpstream({ target: 'http://s2.com', status: 'HEALTHY' })
    ];
    const coordinator = new FailoverCoordinator(endpoints, createMockRoute(), 5000);

    const stats = coordinator.getStats();
    expect(stats.total).toBe(2);
    expect(stats.attempted).toBe(0);
    expect(stats.skipped).toBe(0);
  });

  it('should skip is_disabled endpoints', () => {
    const endpoints = [
      createMockUpstream({ target: 'http://s1.com', is_disabled: false }),
      createMockUpstream({ target: 'http://s2.com', is_disabled: true }),
    ];
    const coordinator = new FailoverCoordinator(endpoints, createMockRoute(), 5000);
    expect(coordinator.getStats().total).toBe(1);
  });

  it('should fallback to lower priority when higher priority is exhausted', () => {
    const endpoints = [
      createMockUpstream({ target: 'http://p1.com', priority: 1, status: 'HEALTHY' }),
      createMockUpstream({ target: 'http://p2.com', priority: 2, status: 'HEALTHY' })
    ];
    const coordinator = new FailoverCoordinator(endpoints, createMockRoute(), 5000);

    expect(coordinator.selectNext()!.upstream.target).toBe('http://p1.com');
    expect(coordinator.selectNext()!.upstream.target).toBe('http://p2.com');
  });

  it('should skip unhealthy endpoints within recovery interval', () => {
    const endpoints = [
      createMockUpstream({
        target: 'http://unhealthy.com',
        status: 'UNHEALTHY',
        last_failure_time: Date.now() - 1000,
        priority: 1
      }),
      createMockUpstream({ target: 'http://healthy.com', status: 'HEALTHY', priority: 2 })
    ];
    const coordinator = new FailoverCoordinator(endpoints, createMockRoute(), 5000);

    const first = coordinator.selectNext();
    expect(first!.upstream.target).toBe('http://healthy.com');
  });

  it('should attempt unhealthy upstream after recovery interval', () => {
    const endpoints = [
      createMockUpstream({
        target: 'http://recovering.com',
        status: 'UNHEALTHY',
        last_failure_time: Date.now() - 6000,
        priority: 1
      }),
      createMockUpstream({ target: 'http://healthy.com', status: 'HEALTHY', priority: 2 })
    ];
    const coordinator = new FailoverCoordinator(endpoints, createMockRoute(), 5000);
    const result = coordinator.selectNext();
    expect(result).not.toBeNull();
    expect(result!.upstream.target).toBe('http://healthy.com');
  });

  it('should keep sticky selection deterministic for same context', () => {
    const endpoints = [
      createMockUpstream({ target: 'http://sticky-a.com', priority: 1, status: 'HEALTHY', upstream_id: 'sticky-a' }),
      createMockUpstream({ target: 'http://sticky-b.com', priority: 1, status: 'HEALTHY', upstream_id: 'sticky-b' })
    ];

    const route = createMockRoute({
      service: 'sticky-service',
      load_balancing: {
        policy: 'consistent_hash',
        hash_policy: { expression: "{{ headers['x-session-id'] }}" }
      },
      state_key: 'sticky-service'
    });
    runtimeState.clear();
    runtimeState.set('sticky-service', {
      upstreams: endpoints,
      load_balancing: {
        policy: 'consistent_hash',
        hash_policy: { expression: "{{ headers['x-session-id'] }}" }
      },
    });

    const context: ExpressionContext = {
      headers: { 'x-session-id': 'conversation-777' },
      body: {},
      url: { pathname: '/test', search: '', host: 'localhost', protocol: 'http:' },
      method: 'POST',
      env: {}
    };

    const first = new FailoverCoordinator(endpoints, route, 5000, context).selectNext();
    const second = new FailoverCoordinator(endpoints, route, 5000, context).selectNext();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.upstream.target).toBe(second!.upstream.target);
  });

  it('should track upstreams by upstream_id (not target) — same target different ids', () => {
    const endpoints = [
      createMockUpstream({ target: 'http://shared.com', upstream_id: 'id-1', status: 'HEALTHY', priority: 1 }),
      createMockUpstream({ target: 'http://shared.com', upstream_id: 'id-2', status: 'HEALTHY', priority: 1 })
    ];
    const coordinator = new FailoverCoordinator(endpoints, createMockRoute(), 5000);

    const first = coordinator.selectNext();
    expect(first).not.toBeNull();
    const firstId = first!.upstream.upstream_id;

    const second = coordinator.selectNext();
    expect(second).not.toBeNull();
    expect(second!.upstream.upstream_id).not.toBe(firstId);
  });

  it('should treat priority=0 as highest priority', () => {
    const endpoints = [
      createMockUpstream({ target: 'http://p0.com', priority: 0, status: 'HEALTHY', upstream_id: 'p0' }),
      createMockUpstream({ target: 'http://p1.com', priority: 1, status: 'HEALTHY', upstream_id: 'p1' })
    ];
    const coordinator = new FailoverCoordinator(endpoints, createMockRoute(), 5000);

    const first = coordinator.selectNext();
    expect(first).not.toBeNull();
    expect(first!.upstream.upstream_id).toBe('p0');
  });
});
