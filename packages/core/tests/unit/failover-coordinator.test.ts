import { describe, it, expect } from 'bun:test';
import { FailoverCoordinator } from '../../src/worker/upstream/failover-coordinator';
import type { RuntimeUpstream } from '../../src/worker/types';
import type { RouteConfig } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../../src/expression-engine';

function createMockUpstream(overrides: Partial<RuntimeUpstream> = {}): RuntimeUpstream {
  const upstreamId = overrides.upstreamId ?? (typeof overrides.target === 'string' ? overrides.target : 'upstream-default');

  return {
    target: 'http://example.com',
    weight: 100,
    priority: 1,
    disabled: false,
    status: 'HEALTHY',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    recoveryAttemptCount: 0,
    ...overrides,
    upstreamId
  };
}

function createMockRoute(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    configVersion: 2,
    path: '/test',
    upstreams: [],
    failover: {
      enabled: true,
      retryOn: [502, 503, 504],
      slowStart: {
        enabled: false
      }
    },
    ...overrides
  };
}

describe('FailoverCoordinator', () => {
  it('should initialize with upstreams', () => {
    const upstreams = [
      createMockUpstream({ target: 'http://s1.com', status: 'HEALTHY' }),
      createMockUpstream({ target: 'http://s2.com', status: 'HEALTHY' })
    ];
    const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

    const stats = coordinator.getStats();
    expect(stats.total).toBe(2);
    expect(stats.attempted).toBe(0);
    expect(stats.skipped).toBe(0);
  });

  it('should skip disabled upstreams', () => {
    const upstreams = [
      createMockUpstream({ target: 'http://s1.com', disabled: false }),
      createMockUpstream({ target: 'http://s2.com', disabled: true }),
    ];
    const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);
    expect(coordinator.getStats().total).toBe(1);
  });

  it('should fallback to lower priority when higher priority is exhausted', () => {
    const upstreams = [
      createMockUpstream({ target: 'http://p1.com', priority: 1, status: 'HEALTHY' }),
      createMockUpstream({ target: 'http://p2.com', priority: 2, status: 'HEALTHY' })
    ];
    const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

    expect(coordinator.selectNext()!.upstream.target).toBe('http://p1.com');
    expect(coordinator.selectNext()!.upstream.target).toBe('http://p2.com');
  });

  it('should skip unhealthy upstreams within recovery interval', () => {
    const upstreams = [
      createMockUpstream({
        target: 'http://unhealthy.com',
        status: 'UNHEALTHY',
        lastFailureTime: Date.now() - 1000,
        priority: 1
      }),
      createMockUpstream({ target: 'http://healthy.com', status: 'HEALTHY', priority: 2 })
    ];
    const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

    const first = coordinator.selectNext();
    expect(first!.upstream.target).toBe('http://healthy.com');
    expect(coordinator.getStats().skipped).toBe(1);
  });

  it('should attempt unhealthy upstream after recovery interval', () => {
    const upstreams = [
      createMockUpstream({
        target: 'http://recovering.com',
        status: 'UNHEALTHY',
        lastFailureTime: Date.now() - 6000,
        priority: 1
      })
    ];
    const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);
    const result = coordinator.selectNext();
    expect(result).not.toBeNull();
    expect(result!.shouldTransitionToHalfOpen).toBe(true);
  });

  it('should keep sticky selection deterministic for same context', () => {
    const upstreams = [
      createMockUpstream({ target: 'http://sticky-a.com', priority: 1, status: 'HEALTHY', upstreamId: 'sticky-a' }),
      createMockUpstream({ target: 'http://sticky-b.com', priority: 1, status: 'HEALTHY', upstreamId: 'sticky-b' })
    ];

    const route = createMockRoute({
      stickySession: {
        enabled: true,
        keyExpression: "{{ headers['x-session-id'] }}"
      }
    });

    const context: ExpressionContext = {
      headers: { 'x-session-id': 'conversation-777' },
      body: {},
      url: { pathname: '/test', search: '', host: 'localhost', protocol: 'http:' },
      method: 'POST',
      env: {}
    };

    const first = new FailoverCoordinator(upstreams, route, 5000, context).selectNext();
    const second = new FailoverCoordinator(upstreams, route, 5000, context).selectNext();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.upstream.target).toBe(second!.upstream.target);
  });
});
