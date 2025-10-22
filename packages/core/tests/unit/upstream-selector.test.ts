import { describe, it, expect } from 'bun:test';
import { selectUpstream } from '../../src/worker/upstream/selector';
import type { RuntimeUpstream } from '../../src/worker/types';

describe('selectUpstream', () => {
  it('should return undefined for empty array', () => {
    const result = selectUpstream([]);
    expect(result).toBeUndefined();
  });

  it('should select the only upstream', () => {
    const upstreams: RuntimeUpstream[] = [
      {
        target: 'http://localhost:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 1
      }
    ];
    const result = selectUpstream(upstreams);
    expect(result).toBe(upstreams[0]);
  });

  it('should select from single priority group', () => {
    const upstreams: RuntimeUpstream[] = [
      {
        target: 'http://server1:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 1
      },
      {
        target: 'http://server2:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 1
      }
    ];
    const result = selectUpstream(upstreams);
    expect(result).toBeDefined();
    expect([upstreams[0], upstreams[1]]).toContain(result);
  });

  it('should prioritize lower priority numbers', () => {
    const upstreams: RuntimeUpstream[] = [
      {
        target: 'http://priority2:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 2
      },
      {
        target: 'http://priority1:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 1
      }
    ];

    // Run multiple times to ensure priority 1 always wins
    for (let i = 0; i < 10; i++) {
      const result = selectUpstream(upstreams);
      expect(result?.priority).toBe(1);
      expect(result?.target).toBe('http://priority1:3000');
    }
  });

  it('should use weighted random within same priority', () => {
    const upstreams: RuntimeUpstream[] = [
      {
        target: 'http://heavy:3000',
        status: 'HEALTHY',
        weight: 900,  // 90% weight
        priority: 1
      },
      {
        target: 'http://light:3000',
        status: 'HEALTHY',
        weight: 100,  // 10% weight
        priority: 1
      }
    ];

    // Run 100 times and check distribution
    const counts = { heavy: 0, light: 0 };
    for (let i = 0; i < 100; i++) {
      const result = selectUpstream(upstreams);
      if (result?.target === 'http://heavy:3000') counts.heavy++;
      if (result?.target === 'http://light:3000') counts.light++;
    }

    // Heavy should be selected more often (allow for randomness)
    expect(counts.heavy).toBeGreaterThan(counts.light);
    // Heavy should get roughly 90% (with tolerance for randomness)
    expect(counts.heavy).toBeGreaterThan(70);
    expect(counts.heavy).toBeLessThan(100);
  });

  it('should handle upstreams with default weight (100)', () => {
    const upstreams: RuntimeUpstream[] = [
      {
        target: 'http://server1:3000',
        status: 'HEALTHY',
        // No weight specified, should default to 100
        priority: 1
      },
      {
        target: 'http://server2:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 1
      }
    ];

    const result = selectUpstream(upstreams);
    expect(result).toBeDefined();
    expect([upstreams[0], upstreams[1]]).toContain(result);
  });

  it('should handle upstreams with default priority (1)', () => {
    const upstreams: RuntimeUpstream[] = [
      {
        target: 'http://server1:3000',
        status: 'HEALTHY',
        weight: 100
        // No priority specified, should default to 1
      },
      {
        target: 'http://server2:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 1
      }
    ];

    const result = selectUpstream(upstreams);
    expect(result).toBeDefined();
  });

  it('should skip priority groups with zero total weight', () => {
    const upstreams: RuntimeUpstream[] = [
      {
        target: 'http://zero-weight:3000',
        status: 'HEALTHY',
        weight: 0,
        priority: 1
      },
      {
        target: 'http://normal:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 2
      }
    ];

    const result = selectUpstream(upstreams);
    expect(result?.target).toBe('http://normal:3000');
  });

  it('should handle mixed priority levels correctly', () => {
    const upstreams: RuntimeUpstream[] = [
      {
        target: 'http://p3:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 3
      },
      {
        target: 'http://p1-a:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 1
      },
      {
        target: 'http://p2:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 2
      },
      {
        target: 'http://p1-b:3000',
        status: 'HEALTHY',
        weight: 100,
        priority: 1
      }
    ];

    // Should always select from priority 1
    for (let i = 0; i < 20; i++) {
      const result = selectUpstream(upstreams);
      expect(result?.priority).toBe(1);
      expect(['http://p1-a:3000', 'http://p1-b:3000']).toContain(result?.target);
    }
  });
});
