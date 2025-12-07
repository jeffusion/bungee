import { describe, it, expect } from 'bun:test';
import { FailoverCoordinator } from '../../src/worker/upstream/failover-coordinator';
import type { RuntimeUpstream } from '../../src/worker/types';
import type { RouteConfig } from '@jeffusion/bungee-types';

// Helper function to create mock upstreams
function createMockUpstream(overrides: Partial<RuntimeUpstream> = {}): RuntimeUpstream {
  return {
    target: 'http://example.com',
    weight: 100,
    priority: 1,
    disabled: false,
    status: 'HEALTHY',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    ...overrides
  };
}

// Helper function to create mock route config
function createMockRoute(): RouteConfig {
  return {
    path: '/test',
    upstreams: [],
    failover: {
      enabled: true,
      slowStart: {
        enabled: false
      }
    }
  };
}

describe('FailoverCoordinator', () => {
  describe('Constructor and basic methods', () => {
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

    it('should filter out disabled upstreams', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://s1.com', disabled: false }),
        createMockUpstream({ target: 'http://s2.com', disabled: true }),
        createMockUpstream({ target: 'http://s3.com', disabled: false })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      const stats = coordinator.getStats();
      expect(stats.total).toBe(2); // Only non-disabled upstreams
    });

    it('should handle empty upstream list', () => {
      const coordinator = new FailoverCoordinator([], createMockRoute(), 5000);

      expect(coordinator.hasNext()).toBe(false);
      expect(coordinator.selectNext()).toBeNull();
      expect(coordinator.getStats().total).toBe(0);
    });
  });

  describe('Priority-based selection', () => {
    it('should select from high priority group first', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://p1-s1.com', priority: 1, status: 'HEALTHY' }),
        createMockUpstream({ target: 'http://p2-s1.com', priority: 2, status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      const first = coordinator.selectNext();
      expect(first).not.toBeNull();
      expect(first!.upstream.target).toBe('http://p1-s1.com');
    });

    it('should fallback to lower priority when higher priority is exhausted', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://p1-s1.com', priority: 1, status: 'HEALTHY' }),
        createMockUpstream({ target: 'http://p2-s1.com', priority: 2, status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      const first = coordinator.selectNext(); // p1-s1
      expect(first!.upstream.target).toBe('http://p1-s1.com');

      const second = coordinator.selectNext(); // p2-s1 (priority 1 exhausted)
      expect(second).not.toBeNull();
      expect(second!.upstream.target).toBe('http://p2-s1.com');
    });

    it('should try all upstreams within same priority before moving to next', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://p1-s1.com', priority: 1, status: 'HEALTHY' }),
        createMockUpstream({ target: 'http://p1-s2.com', priority: 1, status: 'HEALTHY' }),
        createMockUpstream({ target: 'http://p2-s1.com', priority: 2, status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      const first = coordinator.selectNext();
      const second = coordinator.selectNext();
      const third = coordinator.selectNext();

      // First two should be from priority 1
      expect(first!.upstream.priority).toBe(1);
      expect(second!.upstream.priority).toBe(1);
      // Third should be from priority 2
      expect(third!.upstream.priority).toBe(2);
    });
  });

  describe('Health status and recovery interval', () => {
    it('should skip UNHEALTHY upstreams within recovery interval', () => {
      const upstreams = [
        createMockUpstream({
          target: 'http://unhealthy.com',
          status: 'UNHEALTHY',
          lastFailureTime: Date.now() - 1000, // 1 second ago
          priority: 1
        }),
        createMockUpstream({ target: 'http://healthy.com', status: 'HEALTHY', priority: 2 })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      const first = coordinator.selectNext();
      expect(first!.upstream.target).toBe('http://healthy.com');

      const stats = coordinator.getStats();
      expect(stats.skipped).toBe(1); // UNHEALTHY upstream was skipped
      expect(stats.attempted).toBe(1);
    });

    it('should attempt UNHEALTHY upstreams after recovery interval', () => {
      const upstreams = [
        createMockUpstream({
          target: 'http://recovering.com',
          status: 'UNHEALTHY',
          lastFailureTime: Date.now() - 6000, // 6 seconds ago, recovery interval is 5 seconds
          priority: 1
        })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      const result = coordinator.selectNext();
      expect(result).not.toBeNull();
      expect(result!.upstream.target).toBe('http://recovering.com');
      expect(result!.shouldTransitionToHalfOpen).toBe(true);
    });

    it('should always attempt HALF_OPEN upstreams', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://halfopen.com', status: 'HALF_OPEN', priority: 1 })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      const result = coordinator.selectNext();
      expect(result).not.toBeNull();
      expect(result!.upstream.target).toBe('http://halfopen.com');
      expect(result!.shouldTransitionToHalfOpen).toBe(false); // Already HALF_OPEN
    });
  });

  describe('hasNext and iteration', () => {
    it('should return true when upstreams are available', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://s1.com', status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      expect(coordinator.hasNext()).toBe(true);
    });

    it('should return false when all upstreams are exhausted', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://s1.com', status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      coordinator.selectNext(); // Attempt s1
      expect(coordinator.hasNext()).toBe(false);
    });

    it('should support complete iteration', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://s1.com', status: 'HEALTHY' }),
        createMockUpstream({ target: 'http://s2.com', status: 'HEALTHY' }),
        createMockUpstream({ target: 'http://s3.com', status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      const selected: string[] = [];
      while (coordinator.hasNext()) {
        const result = coordinator.selectNext();
        if (result) {
          selected.push(result.upstream.target);
        }
      }

      expect(selected.length).toBe(3);
      expect(selected).toContain('http://s1.com');
      expect(selected).toContain('http://s2.com');
      expect(selected).toContain('http://s3.com');
    });
  });

  describe('Statistics tracking', () => {
    it('should track attempted upstreams', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://s1.com', status: 'HEALTHY' }),
        createMockUpstream({ target: 'http://s2.com', status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      coordinator.selectNext();
      let stats = coordinator.getStats();
      expect(stats.attempted).toBe(1);
      expect(stats.skipped).toBe(0);

      coordinator.selectNext();
      stats = coordinator.getStats();
      expect(stats.attempted).toBe(2);
      expect(stats.skipped).toBe(0);
    });

    it('should track skipped upstreams', () => {
      const upstreams = [
        createMockUpstream({
          target: 'http://unhealthy.com',
          status: 'UNHEALTHY',
          lastFailureTime: Date.now() - 1000,
          priority: 1
        }),
        createMockUpstream({ target: 'http://healthy.com', status: 'HEALTHY', priority: 1 })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      // Try to exhaust all upstreams in priority 1
      coordinator.selectNext(); // First selection
      coordinator.selectNext(); // Second selection should encounter the UNHEALTHY one

      const stats = coordinator.getStats();
      expect(stats.attempted).toBeGreaterThanOrEqual(1);
      expect(stats.skipped).toBeGreaterThanOrEqual(1);
      expect(stats.total).toBe(2);
    });
  });

  describe('Complex scenarios', () => {
    it('should handle mixed priority and health status', () => {
      const upstreams = [
        createMockUpstream({
          target: 'http://p1-unhealthy.com',
          priority: 1,
          status: 'UNHEALTHY',
          lastFailureTime: Date.now() - 1000
        }),
        createMockUpstream({
          target: 'http://p1-healthy.com',
          priority: 1,
          status: 'HEALTHY'
        }),
        createMockUpstream({
          target: 'http://p2-healthy.com',
          priority: 2,
          status: 'HEALTHY'
        })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      // First selection should be p1-healthy (p1-unhealthy skipped due to recovery interval)
      const first = coordinator.selectNext();
      expect(first!.upstream.target).toBe('http://p1-healthy.com');

      // Second selection should be p2-healthy (priority 1 exhausted)
      const second = coordinator.selectNext();
      expect(second!.upstream.target).toBe('http://p2-healthy.com');

      // No more upstreams
      expect(coordinator.hasNext()).toBe(false);

      const stats = coordinator.getStats();
      expect(stats.attempted).toBe(2);
      expect(stats.skipped).toBe(1);
    });

    it('should handle all upstreams UNHEALTHY within recovery interval', () => {
      const upstreams = [
        createMockUpstream({
          target: 'http://s1.com',
          status: 'UNHEALTHY',
          lastFailureTime: Date.now() - 1000
        }),
        createMockUpstream({
          target: 'http://s2.com',
          status: 'UNHEALTHY',
          lastFailureTime: Date.now() - 2000
        })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      // hasNext() returns true initially because upstreams exist
      expect(coordinator.hasNext()).toBe(true);

      // But selectNext() will skip all and eventually return null
      let result = coordinator.selectNext();
      while (result !== null) {
        result = coordinator.selectNext();
      }

      // After exhausting all, hasNext() should return false
      expect(coordinator.hasNext()).toBe(false);

      const stats = coordinator.getStats();
      expect(stats.attempted).toBe(0);
      expect(stats.skipped).toBe(2);
    });

    it('should handle weighted selection within priority group', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://high-weight.com', priority: 1, weight: 1000, status: 'HEALTHY' }),
        createMockUpstream({ target: 'http://low-weight.com', priority: 1, weight: 1, status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      // Run 100 iterations to test weight distribution
      const results: { [key: string]: number } = {};
      for (let i = 0; i < 100; i++) {
        const coord = new FailoverCoordinator(upstreams, createMockRoute(), 5000);
        const first = coord.selectNext();
        if (first) {
          results[first.upstream.target] = (results[first.upstream.target] || 0) + 1;
        }
      }

      // high-weight should be selected most of the time (~99%)
      expect(results['http://high-weight.com']).toBeGreaterThan(90);
    });
  });

  describe('Edge cases', () => {
    it('should handle single upstream', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://single.com', status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      expect(coordinator.hasNext()).toBe(true);
      const result = coordinator.selectNext();
      expect(result!.upstream.target).toBe('http://single.com');
      expect(coordinator.hasNext()).toBe(false);
    });

    it('should handle all disabled upstreams', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://s1.com', disabled: true }),
        createMockUpstream({ target: 'http://s2.com', disabled: true })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      expect(coordinator.hasNext()).toBe(false);
      expect(coordinator.selectNext()).toBeNull();
      expect(coordinator.getStats().total).toBe(0);
    });

    it('should not select same upstream twice', () => {
      const upstreams = [
        createMockUpstream({ target: 'http://s1.com', status: 'HEALTHY' }),
        createMockUpstream({ target: 'http://s2.com', status: 'HEALTHY' })
      ];
      const coordinator = new FailoverCoordinator(upstreams, createMockRoute(), 5000);

      const first = coordinator.selectNext();
      const second = coordinator.selectNext();

      expect(first!.upstream.target).not.toBe(second!.upstream.target);
    });
  });
});
