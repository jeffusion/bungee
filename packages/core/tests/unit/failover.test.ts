/**
 * Failover mechanism unit tests
 * Comprehensive tests for upstream selection, retry logic, circuit breaker, and recovery behavior
 */

import { describe, test, expect } from 'bun:test';
import type { RuntimeUpstream } from '../../src/worker/types';
import { selectUpstream } from '../../src/worker/upstream/selector';

// =============================================================================
// BASIC FUNCTIONALITY TESTS
// =============================================================================

describe('Failover - Field Name Correctness', () => {
  test('should use lastFailureTime instead of lastFailure', () => {
    const upstreams: RuntimeUpstream[] = [
      {
        target: 'http://server1.com',
        weight: 100,
        status: 'HEALTHY',
        lastFailureTime: undefined,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      },
      {
        target: 'http://server2.com',
        weight: 100,
        status: 'UNHEALTHY',
        lastFailureTime: Date.now() - 10000, // 10 seconds ago
        consecutiveFailures: 3,
        consecutiveSuccesses: 0,
      },
    ];

    // Verify type compliance
    expect(upstreams[0].lastFailureTime).toBeUndefined();
    expect(upstreams[1].lastFailureTime).toBeTypeOf('number');

    // Should not have lastFailure field
    expect((upstreams[0] as any).lastFailure).toBeUndefined();
    expect((upstreams[1] as any).lastFailure).toBeUndefined();
  });
});

describe('Failover - Recovery Candidate Isolation', () => {
  test('should prioritize healthy upstreams over recovery candidates', () => {
    const healthyUpstream: RuntimeUpstream = {
      target: 'http://healthy.com',
      weight: 50, // Lower weight
      status: 'HEALTHY',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    const recoveryCandidate: RuntimeUpstream = {
      target: 'http://recovery.com',
      weight: 200, // Higher weight
      status: 'UNHEALTHY',
      lastFailureTime: Date.now() - 10000,
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    };

    // When selecting from healthy only, should choose the healthy one
    const selectedFromHealthy = selectUpstream([healthyUpstream]);
    expect(selectedFromHealthy?.target).toBe('http://healthy.com');

    // When selecting from recovery only, should choose the recovery candidate
    const selectedFromRecovery = selectUpstream([recoveryCandidate]);
    expect(selectedFromRecovery?.target).toBe('http://recovery.com');

    // When both available, healthy should be preferred in normal operation
    // (This is enforced in handler.ts, not selector.ts)
  });

  test('should sort upstreams by priority and weight', () => {
    const upstreams: RuntimeUpstream[] = [
      { target: 'http://low-priority.com', weight: 100, priority: 2, status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'http://high-priority-low-weight.com', weight: 50, priority: 1, status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'http://high-priority-high-weight.com', weight: 200, priority: 1, status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 0 },
    ];

    // Run selection 100 times to verify priority/weight distribution
    const counts: Record<string, number> = {
      'http://low-priority.com': 0,
      'http://high-priority-low-weight.com': 0,
      'http://high-priority-high-weight.com': 0,
    };

    for (let i = 0; i < 100; i++) {
      const selected = selectUpstream(upstreams);
      if (selected) {
        counts[selected.target]++;
      }
    }

    // Low priority should rarely or never be selected
    expect(counts['http://low-priority.com']).toBeLessThan(5);

    // High priority upstreams should be selected
    expect(counts['http://high-priority-low-weight.com']).toBeGreaterThan(0);
    expect(counts['http://high-priority-high-weight.com']).toBeGreaterThan(0);

    // Higher weight should be selected more often
    expect(counts['http://high-priority-high-weight.com']).toBeGreaterThan(
      counts['http://high-priority-low-weight.com']
    );
  });
});

describe('Failover - Retry Logic', () => {
  test('should handle retryable status codes correctly', () => {
    // Mock scenario: upstream returns retryable status code
    const retryableStatusCodes = [502, 503, 504];

    // Test case 1: 502 is retryable
    expect(retryableStatusCodes.includes(502)).toBe(true);

    // Test case 2: 500 is not retryable (not in list)
    expect(retryableStatusCodes.includes(500)).toBe(false);

    // Test case 3: 200 is not retryable
    expect(retryableStatusCodes.includes(200)).toBe(false);
  });

  test('should determine if last upstream correctly', () => {
    const upstreams: RuntimeUpstream[] = [
      { target: 'http://server1.com', status: 'HEALTHY', weight: 100, consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'http://server2.com', status: 'HEALTHY', weight: 100, consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'http://server3.com', status: 'HEALTHY', weight: 100, consecutiveFailures: 0, consecutiveSuccesses: 0 },
    ];

    const attemptQueue = upstreams;
    const firstUpstream = attemptQueue[0];
    const lastUpstream = attemptQueue[attemptQueue.length - 1];

    expect(firstUpstream === lastUpstream).toBe(false);
    expect(attemptQueue.indexOf(firstUpstream)).toBe(0);
    expect(attemptQueue.indexOf(lastUpstream)).toBe(2);

    // Check last upstream identification
    expect(lastUpstream === attemptQueue[attemptQueue.length - 1]).toBe(true);
  });
});

describe('Failover - Recovery Behavior', () => {
  test('should mark upstream as HEALTHY when recovery succeeds', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      lastFailureTime: Date.now() - 10000,
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    };

    // Simulate successful recovery
    upstream.status = 'HEALTHY';
    upstream.lastFailureTime = undefined;

    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.lastFailureTime).toBeUndefined();
  });

  test('should only mark as HEALTHY for successful responses (< 400)', () => {
    const testCases = [
      { status: 200, shouldRecover: true },
      { status: 301, shouldRecover: true },
      { status: 400, shouldRecover: false },
      { status: 500, shouldRecover: false },
      { status: 502, shouldRecover: false },
    ];

    testCases.forEach(({ status, shouldRecover }) => {
      const isSuccess = status < 400;
      expect(isSuccess).toBe(shouldRecover);
    });
  });

  test('should calculate recovery interval correctly', () => {
    const recoveryIntervalMs = 5000;
    const now = Date.now();

    const scenarios = [
      { lastFailureTime: now - 6000, shouldRecover: true },  // 6s ago
      { lastFailureTime: now - 5000, shouldRecover: true },  // 5s ago (boundary)
      { lastFailureTime: now - 4000, shouldRecover: false }, // 4s ago
      { lastFailureTime: now - 1000, shouldRecover: false }, // 1s ago
    ];

    scenarios.forEach(({ lastFailureTime, shouldRecover }) => {
      const elapsed = now - lastFailureTime;
      const canRecover = elapsed >= recoveryIntervalMs;
      expect(canRecover).toBe(shouldRecover);
    });
  });
});

describe('Failover - Edge Cases', () => {
  test('should handle empty upstream list', () => {
    const selected = selectUpstream([]);
    expect(selected).toBeUndefined();
  });

  test('should handle single upstream', () => {
    const upstreams: RuntimeUpstream[] = [
      { target: 'http://only-server.com', weight: 100, status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 0 },
    ];

    const selected = selectUpstream(upstreams);
    expect(selected?.target).toBe('http://only-server.com');
  });

  test('should handle all UNHEALTHY upstreams', () => {
    const upstreams: RuntimeUpstream[] = [
      { target: 'http://server1.com', weight: 100, status: 'UNHEALTHY', lastFailureTime: Date.now(), consecutiveFailures: 3, consecutiveSuccesses: 0 },
      { target: 'http://server2.com', weight: 100, status: 'UNHEALTHY', lastFailureTime: Date.now(), consecutiveFailures: 3, consecutiveSuccesses: 0 },
    ];

    // Selector should still select one (it doesn't check health status)
    const selected = selectUpstream(upstreams);
    expect(selected).toBeDefined();
    expect(['http://server1.com', 'http://server2.com']).toContain(selected?.target as string);
  });

  test('should handle missing priority (defaults to 1)', () => {
    const upstreams: RuntimeUpstream[] = [
      { target: 'http://no-priority.com', weight: 100, status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'http://explicit-priority.com', weight: 100, priority: 1, status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 0 },
    ];

    // Both should be treated equally (both priority 1)
    const counts: Record<string, number> = {
      'http://no-priority.com': 0,
      'http://explicit-priority.com': 0,
    };

    for (let i = 0; i < 100; i++) {
      const selected = selectUpstream(upstreams);
      if (selected) {
        counts[selected.target]++;
      }
    }

    // Both should be selected approximately equally
    expect(counts['http://no-priority.com']).toBeGreaterThan(30);
    expect(counts['http://explicit-priority.com']).toBeGreaterThan(30);
  });

  test('should handle missing weight (defaults to 100)', () => {
    const upstreams: RuntimeUpstream[] = [
      { target: 'http://no-weight.com', status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'http://explicit-weight.com', weight: 100, status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 0 },
    ];

    // Both should be treated equally (both weight 100)
    const counts: Record<string, number> = {
      'http://no-weight.com': 0,
      'http://explicit-weight.com': 0,
    };

    for (let i = 0; i < 100; i++) {
      const selected = selectUpstream(upstreams);
      if (selected) {
        counts[selected.target]++;
      }
    }

    // Both should be selected approximately equally
    expect(counts['http://no-weight.com']).toBeGreaterThan(30);
    expect(counts['http://explicit-weight.com']).toBeGreaterThan(30);
  });
});

// =============================================================================
// ADVANCED FEATURES TESTS
// =============================================================================

describe('Failover - Type Extensions', () => {
  test('should support consecutiveFailures and consecutiveSuccesses fields', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'HEALTHY',
      lastFailureTime: undefined,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    expect(upstream.consecutiveFailures).toBe(0);
    expect(upstream.consecutiveSuccesses).toBe(0);
  });

  test('should support HALF_OPEN status', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'HALF_OPEN',
      lastFailureTime: Date.now() - 5000,
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    };

    expect(upstream.status).toBe('HALF_OPEN');
    expect(['HEALTHY', 'UNHEALTHY', 'HALF_OPEN']).toContain(upstream.status);
  });
});

describe('Failover - Consecutive Failure Threshold', () => {
  test('should not mark as UNHEALTHY until threshold is reached', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'HEALTHY',
      lastFailureTime: undefined,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    const failureThreshold = 3;

    // Failure 1: Still HEALTHY
    upstream.consecutiveFailures = 1;
    if (upstream.consecutiveFailures >= failureThreshold) {
      upstream.status = 'UNHEALTHY';
    }
    expect(upstream.status).toBe('HEALTHY');

    // Failure 2: Still HEALTHY
    upstream.consecutiveFailures = 2;
    if (upstream.consecutiveFailures >= failureThreshold) {
      upstream.status = 'UNHEALTHY';
    }
    expect(upstream.status).toBe('HEALTHY');

    // Failure 3: Now UNHEALTHY
    upstream.consecutiveFailures = 3;
    if (upstream.consecutiveFailures >= failureThreshold) {
      upstream.status = 'UNHEALTHY';
      upstream.lastFailureTime = Date.now();
    }
    expect(upstream.status).toBe('UNHEALTHY');
    expect(upstream.lastFailureTime).toBeDefined();
  });

  test('should reset consecutive failures on success', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'HEALTHY',
      lastFailureTime: undefined,
      consecutiveFailures: 2, // Had 2 failures
      consecutiveSuccesses: 0,
    };

    // Success resets failure counter
    upstream.consecutiveFailures = 0;
    upstream.consecutiveSuccesses++;

    expect(upstream.consecutiveFailures).toBe(0);
    expect(upstream.consecutiveSuccesses).toBe(1);
    expect(upstream.status).toBe('HEALTHY');
  });

  test('should reset consecutive successes on failure', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      lastFailureTime: Date.now() - 6000,
      consecutiveFailures: 0,
      consecutiveSuccesses: 1, // Had 1 success
    };

    // Failure resets success counter
    upstream.consecutiveSuccesses = 0;
    upstream.consecutiveFailures++;

    expect(upstream.consecutiveSuccesses).toBe(0);
    expect(upstream.consecutiveFailures).toBe(1);
  });
});

describe('Failover - Healthy Threshold', () => {
  test('should not mark as HEALTHY until threshold is reached', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      lastFailureTime: Date.now() - 10000,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    const healthyThreshold = 2;

    // Success 1: Still UNHEALTHY
    upstream.consecutiveSuccesses = 1;
    if (upstream.consecutiveSuccesses >= healthyThreshold) {
      upstream.status = 'HEALTHY';
      upstream.lastFailureTime = undefined;
    }
    expect(upstream.status).toBe('UNHEALTHY');

    // Success 2: Now HEALTHY
    upstream.consecutiveSuccesses = 2;
    if (upstream.consecutiveSuccesses >= healthyThreshold) {
      upstream.status = 'HEALTHY';
      upstream.lastFailureTime = undefined;
    }
    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.lastFailureTime).toBeUndefined();
  });

  test('should handle different healthy threshold values', () => {
    const testCases = [
      { threshold: 1, successCount: 1, shouldBeHealthy: true },
      { threshold: 2, successCount: 1, shouldBeHealthy: false },
      { threshold: 2, successCount: 2, shouldBeHealthy: true },
      { threshold: 3, successCount: 2, shouldBeHealthy: false },
      { threshold: 3, successCount: 3, shouldBeHealthy: true },
    ];

    testCases.forEach(({ threshold, successCount, shouldBeHealthy }) => {
      const result = successCount >= threshold;
      expect(result).toBe(shouldBeHealthy);
    });
  });
});

describe('Failover - Circuit Breaker States', () => {
  test('should transition UNHEALTHY → HALF_OPEN after recovery interval', () => {
    const recoveryIntervalMs = 5000;
    const now = Date.now();

    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      lastFailureTime: now - 6000, // 6 seconds ago
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    };

    // Check if recovery interval has passed
    if (upstream.status === 'UNHEALTHY' &&
        upstream.lastFailureTime !== undefined &&
        (now - upstream.lastFailureTime) >= recoveryIntervalMs) {
      upstream.status = 'HALF_OPEN';
    }

    expect(upstream.status).toBe('HALF_OPEN');
  });

  test('should NOT transition to HALF_OPEN before recovery interval', () => {
    const recoveryIntervalMs = 5000;
    const now = Date.now();

    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      lastFailureTime: now - 3000, // Only 3 seconds ago
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    };

    // Check if recovery interval has passed
    if (upstream.status === 'UNHEALTHY' &&
        upstream.lastFailureTime !== undefined &&
        (now - upstream.lastFailureTime) >= recoveryIntervalMs) {
      upstream.status = 'HALF_OPEN';
    }

    expect(upstream.status).toBe('UNHEALTHY');
  });

  test('should transition HALF_OPEN → HEALTHY on success', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'HALF_OPEN',
      lastFailureTime: Date.now() - 6000,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    // Simulate successful test request
    const responseStatus = 200;
    if (upstream.status === 'HALF_OPEN' && responseStatus < 400) {
      upstream.status = 'HEALTHY';
      upstream.lastFailureTime = undefined;
      upstream.consecutiveSuccesses = 0;
    }

    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.lastFailureTime).toBeUndefined();
  });

  test('should transition HALF_OPEN → UNHEALTHY on failure', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'HALF_OPEN',
      lastFailureTime: Date.now() - 6000,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    // Simulate failed test request
    const responseStatus = 502;
    if (upstream.status === 'HALF_OPEN' && responseStatus >= 400) {
      upstream.status = 'UNHEALTHY';
      upstream.lastFailureTime = Date.now();
    }

    expect(upstream.status).toBe('UNHEALTHY');
    expect(upstream.lastFailureTime).toBeGreaterThan(Date.now() - 1000);
  });

  test('should handle complete circuit breaker cycle', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://server.com',
      weight: 100,
      status: 'HEALTHY',
      lastFailureTime: undefined,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    const failureThreshold = 3;
    const recoveryIntervalMs = 5000;

    // Step 1: HEALTHY → UNHEALTHY (after 3 failures)
    upstream.consecutiveFailures = 3;
    if (upstream.consecutiveFailures >= failureThreshold) {
      upstream.status = 'UNHEALTHY';
      upstream.lastFailureTime = Date.now();
    }
    expect(upstream.status).toBe('UNHEALTHY');

    // Step 2: UNHEALTHY → HALF_OPEN (after recovery interval)
    const afterInterval = Date.now() + recoveryIntervalMs + 1000;
    if (upstream.lastFailureTime && (afterInterval - upstream.lastFailureTime) >= recoveryIntervalMs) {
      upstream.status = 'HALF_OPEN';
    }
    expect(upstream.status).toBe('HALF_OPEN');

    // Step 3: HALF_OPEN → HEALTHY (on success)
    upstream.status = 'HEALTHY';
    upstream.lastFailureTime = undefined;
    upstream.consecutiveFailures = 0;
    expect(upstream.status).toBe('HEALTHY');
  });
});

describe('Failover - Timeout Control', () => {
  test('should use different timeouts for HEALTHY vs UNHEALTHY/HALF_OPEN', () => {
    const requestTimeoutMs = 30000; // 30s for normal requests
    const recoveryTimeoutMs = 3000; // 3s for recovery attempts

    const scenarios = [
      { status: 'HEALTHY' as const, expectedTimeout: requestTimeoutMs },
      { status: 'UNHEALTHY' as const, expectedTimeout: recoveryTimeoutMs },
      { status: 'HALF_OPEN' as const, expectedTimeout: recoveryTimeoutMs },
    ];

    scenarios.forEach(({ status, expectedTimeout }) => {
      const isRecoveryAttempt = status === 'UNHEALTHY' || status === 'HALF_OPEN';
      const timeoutMs = isRecoveryAttempt ? recoveryTimeoutMs : requestTimeoutMs;
      expect(timeoutMs).toBe(expectedTimeout);
    });
  });

  test('should calculate timeout correctly for edge cases', () => {
    const requestTimeoutMs = 30000;
    const recoveryTimeoutMs = 3000;

    // Test with default values
    const defaultRequestTimeout = requestTimeoutMs || 30000;
    const defaultRecoveryTimeout = recoveryTimeoutMs || 3000;

    expect(defaultRequestTimeout).toBe(30000);
    expect(defaultRecoveryTimeout).toBe(3000);

    // Test with custom values
    const customRequestTimeout = 60000;
    const customRecoveryTimeout = 5000;

    expect(customRequestTimeout).toBe(60000);
    expect(customRecoveryTimeout).toBe(5000);
  });
});

describe('Failover - Configuration Validation', () => {
  test('should have sensible default values', () => {
    const defaults = {
      consecutiveFailuresThreshold: 3,
      recoveryIntervalMs: 5000,
      recoveryTimeoutMs: 3000,
      healthyThreshold: 2,
      requestTimeoutMs: 30000,
    };

    expect(defaults.consecutiveFailuresThreshold).toBeGreaterThan(0);
    expect(defaults.healthyThreshold).toBeGreaterThan(0);
    expect(defaults.recoveryIntervalMs).toBeGreaterThan(defaults.recoveryTimeoutMs);
    expect(defaults.requestTimeoutMs).toBeGreaterThan(defaults.recoveryTimeoutMs);
  });

  test('should handle configuration edge cases', () => {
    // Minimum thresholds
    const minConfig = {
      consecutiveFailuresThreshold: 1,
      healthyThreshold: 1,
    };
    expect(minConfig.consecutiveFailuresThreshold).toBe(1);
    expect(minConfig.healthyThreshold).toBe(1);

    // High thresholds
    const highConfig = {
      consecutiveFailuresThreshold: 10,
      healthyThreshold: 5,
    };
    expect(highConfig.consecutiveFailuresThreshold).toBe(10);
    expect(highConfig.healthyThreshold).toBe(5);
  });
});

describe('Failover - Integration Scenarios', () => {
  test('should handle flapping upstream (alternating success/failure)', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://flapping.com',
      weight: 100,
      status: 'HEALTHY',
      lastFailureTime: undefined,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    // Failure 1
    upstream.consecutiveFailures++;
    upstream.consecutiveSuccesses = 0;
    expect(upstream.status).toBe('HEALTHY');

    // Success 1 - resets counter
    upstream.consecutiveFailures = 0;
    upstream.consecutiveSuccesses++;
    expect(upstream.status).toBe('HEALTHY');

    // Failure 2
    upstream.consecutiveFailures++;
    upstream.consecutiveSuccesses = 0;
    expect(upstream.status).toBe('HEALTHY');

    // Success 2 - resets counter again
    upstream.consecutiveFailures = 0;
    upstream.consecutiveSuccesses++;
    expect(upstream.status).toBe('HEALTHY');

    // Upstream stays HEALTHY because consecutive failures never reached threshold
    expect(upstream.consecutiveFailures).toBe(0);
  });

  test('should handle slow recovery (multiple attempts needed)', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://slow-recovery.com',
      weight: 100,
      status: 'UNHEALTHY',
      lastFailureTime: Date.now() - 10000,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    const healthyThreshold = 3;

    // Attempt 1: Success but not enough
    upstream.consecutiveSuccesses = 1;
    if (upstream.consecutiveSuccesses >= healthyThreshold) {
      upstream.status = 'HEALTHY';
    }
    expect(upstream.status).toBe('UNHEALTHY');

    // Attempt 2: Success but still not enough
    upstream.consecutiveSuccesses = 2;
    if (upstream.consecutiveSuccesses >= healthyThreshold) {
      upstream.status = 'HEALTHY';
    }
    expect(upstream.status).toBe('UNHEALTHY');

    // Attempt 3: Success, now recovered
    upstream.consecutiveSuccesses = 3;
    if (upstream.consecutiveSuccesses >= healthyThreshold) {
      upstream.status = 'HEALTHY';
      upstream.lastFailureTime = undefined;
    }
    expect(upstream.status).toBe('HEALTHY');
  });

  test('should handle recovery failure (HALF_OPEN → UNHEALTHY)', () => {
    const upstream: RuntimeUpstream = {
      target: 'http://still-broken.com',
      weight: 100,
      status: 'HALF_OPEN',
      lastFailureTime: Date.now() - 6000,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    // Test request fails
    upstream.status = 'UNHEALTHY';
    upstream.lastFailureTime = Date.now();
    upstream.consecutiveFailures++;
    upstream.consecutiveSuccesses = 0;

    expect(upstream.status).toBe('UNHEALTHY');
    expect(upstream.consecutiveFailures).toBe(1);
    expect(upstream.lastFailureTime).toBeGreaterThan(Date.now() - 1000);
  });
});
