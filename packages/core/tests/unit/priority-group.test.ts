import { describe, it, expect } from 'bun:test';
import { PriorityGroup } from '../../src/worker/upstream/priority-group';
import type { EffectiveRouteConfig, RuntimeUpstream } from '../../src/worker/types';

// Helper function to create mock endpoints
function createMockUpstream(overrides: Partial<RuntimeUpstream> = {}): RuntimeUpstream {
  const upstream_id = overrides.upstream_id
    ?? (typeof overrides.target === 'string' ? overrides.target : 'upstream-default');

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

// Helper function to create mock route config
function createMockRoute(): EffectiveRouteConfig {
  return {
    path: '/test',
    endpoints: [],
    failover: {
      enabled: true,
      retry_on: [502, 503, 504],
      slow_start: {
        enabled: false
      }
    }
  };
}

describe('PriorityGroup', () => {
  describe('Constructor and basic methods', () => {
    it('should create a priority group with given priority', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      expect(group.getPriority()).toBe(1);
      expect(group.getUpstreamCount()).toBe(0);
    });

    it('should add endpoints to the group', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      const upstream1 = createMockUpstream({ target: 'http://s1.com' });
      const upstream2 = createMockUpstream({ target: 'http://s2.com' });

      group.addUpstream(upstream1);
      group.addUpstream(upstream2);

      expect(group.getUpstreamCount()).toBe(2);
    });
  });

  describe('hasAvailable', () => {
    it('should return true when endpoints are available', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://s1.com', status: 'HEALTHY' }));
      group.addUpstream(createMockUpstream({ target: 'http://s2.com', status: 'HEALTHY' }));

      const attempted = new Set<string>();
      const skipped = new Set<string>();

      expect(group.hasAvailable(attempted, skipped)).toBe(true);
    });

    it('should return false when all endpoints are attempted', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://s1.com' }));
      group.addUpstream(createMockUpstream({ target: 'http://s2.com' }));

      const attempted = new Set(['http://s1.com', 'http://s2.com']);
      const skipped = new Set<string>();

      expect(group.hasAvailable(attempted, skipped)).toBe(false);
    });

    it('should return false when all endpoints are skipped', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://s1.com' }));

      const attempted = new Set<string>();
      const skipped = new Set(['http://s1.com']);

      expect(group.hasAvailable(attempted, skipped)).toBe(false);
    });

    it('should return true when some endpoints are still available', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://s1.com' }));
      group.addUpstream(createMockUpstream({ target: 'http://s2.com' }));
      group.addUpstream(createMockUpstream({ target: 'http://s3.com' }));

      const attempted = new Set(['http://s1.com']);
      const skipped = new Set(['http://s2.com']);

      expect(group.hasAvailable(attempted, skipped)).toBe(true);
    });
  });

  describe('selectOne', () => {
    it('should select an upstream when available', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://s1.com', status: 'HEALTHY' }));

      const result = group.selectOne(new Set(), new Set());

      expect(result).not.toBeNull();
      expect(result!.upstream.target).toBe('http://s1.com');
      expect(result!.canAttempt).toBe(true);
      expect(result!.shouldTransitionToHalfOpen).toBe(false);
    });

    it('should return null when no endpoints are available', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://s1.com' }));

      const attempted = new Set(['http://s1.com']);
      const result = group.selectOne(attempted, new Set());

      expect(result).toBeNull();
    });

    it('should filter out attempted endpoints', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://s1.com', weight: 100, status: 'HEALTHY' }));
      group.addUpstream(createMockUpstream({ target: 'http://s2.com', weight: 100, status: 'HEALTHY' }));

      const attempted = new Set(['http://s1.com']);
      const result = group.selectOne(attempted, new Set());

      expect(result).not.toBeNull();
      expect(result!.upstream.target).toBe('http://s2.com');
    });

    it('should filter out skipped endpoints', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://s1.com', weight: 100, status: 'HEALTHY' }));
      group.addUpstream(createMockUpstream({ target: 'http://s2.com', weight: 100, status: 'HEALTHY' }));

      const skipped = new Set(['http://s1.com']);
      const result = group.selectOne(new Set(), skipped);

      expect(result).not.toBeNull();
      expect(result!.upstream.target).toBe('http://s2.com');
    });

    it('should NOT select UNHEALTHY upstream when HEALTHY alternatives exist', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({
        target: 'http://unhealthy.com',
        status: 'UNHEALTHY',
        last_failure_time: Date.now() - 1000,
        upstream_id: 'unhealthy'
      }));
      group.addUpstream(createMockUpstream({
        target: 'http://healthy.com',
        status: 'HEALTHY',
        upstream_id: 'healthy'
      }));

      for (let i = 0; i < 20; i++) {
        const result = group.selectOne(new Set(), new Set());
        expect(result).not.toBeNull();
        expect(result!.upstream.status).not.toBe('UNHEALTHY');
      }
    });

    it('should return null when all upstreams are UNHEALTHY (filtered out)', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({
        target: 'http://recovering.com',
        status: 'UNHEALTHY',
        last_failure_time: Date.now() - 6000,
        upstream_id: 'recovering'
      }));

      const result = group.selectOne(new Set(), new Set());
      expect(result).toBeNull();
    });

    it('should handle HALF_OPEN endpoints correctly', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({
        target: 'http://halfopen.com',
        status: 'HALF_OPEN'
      }));

      const result = group.selectOne(new Set(), new Set());

      expect(result).not.toBeNull();
      expect(result!.canAttempt).toBe(true);
      expect(result!.shouldTransitionToHalfOpen).toBe(false);
    });

    it('should use weighted random selection', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      // s1 has much higher weight than s2
      group.addUpstream(createMockUpstream({ target: 'http://s1.com', weight: 1000, status: 'HEALTHY' }));
      group.addUpstream(createMockUpstream({ target: 'http://s2.com', weight: 1, status: 'HEALTHY' }));

      // Run selection 100 times, s1 should be selected most of the time
      let s1Count = 0;
      for (let i = 0; i < 100; i++) {
        const result = group.selectOne(new Set(), new Set());
        if (result && result.upstream.target === 'http://s1.com') {
          s1Count++;
        }
      }

      // With 1000:1 weight ratio, s1 should be selected ~99% of the time
      expect(s1Count).toBeGreaterThan(90);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty group', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);

      expect(group.getUpstreamCount()).toBe(0);
      expect(group.hasAvailable(new Set(), new Set())).toBe(false);
      expect(group.selectOne(new Set(), new Set())).toBeNull();
    });

    it('should handle single upstream', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://single.com', status: 'HEALTHY' }));

      const result = group.selectOne(new Set(), new Set());
      expect(result).not.toBeNull();
      expect(result!.upstream.target).toBe('http://single.com');
    });

    it('should handle all endpoints with zero weight gracefully', () => {
      const group = new PriorityGroup(1, createMockRoute(), 5000);
      group.addUpstream(createMockUpstream({ target: 'http://s1.com', weight: 0, status: 'HEALTHY' }));
      group.addUpstream(createMockUpstream({ target: 'http://s2.com', weight: 0, status: 'HEALTHY' }));

      // With all zero weights, selector returns undefined, which becomes null
      const result = group.selectOne(new Set(), new Set());
      // Note: Currently selector.ts still returns the last upstream as fallback due to floating point precision
      // This is existing behavior we're preserving
      expect(result).not.toBeNull();
      expect(['http://s1.com', 'http://s2.com']).toContain(result!.upstream.target);
    });
  });
});
