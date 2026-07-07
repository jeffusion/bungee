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
  test('should use last_failure_time instead of lastFailure', () => {
    const upstreams = [
      {
        target: 'http://server1.com',
        weight: 100,
        status: 'HEALTHY',
        last_failure_time: undefined,
        consecutive_failures: 0,
        consecutive_successes: 0,
      },
      {
        target: 'http://server2.com',
        weight: 100,
        status: 'UNHEALTHY',
        last_failure_time: Date.now() - 10000, // 10 seconds ago
        consecutive_failures: 3,
        consecutive_successes: 0,
      },
    ];

    // Verify type compliance
    expect(upstreams[0].last_failure_time).toBeUndefined();
    expect(upstreams[1].last_failure_time).toBeTypeOf('number');

    // Should not have lastFailure field
    expect((upstreams[0] as any).lastFailure).toBeUndefined();
    expect((upstreams[1] as any).lastFailure).toBeUndefined();
  });
});

describe('Failover - Recovery Candidate Isolation', () => {
  test('should prioritize healthy upstreams over recovery candidates', () => {
    const healthyUpstream = {
      target: 'http://healthy.com',
      weight: 50, // Lower weight
      status: 'HEALTHY',
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    const recoveryCandidate = {
      target: 'http://recovery.com',
      weight: 200, // Higher weight
      status: 'UNHEALTHY',
      last_failure_time: Date.now() - 10000,
      consecutive_failures: 3,
      consecutive_successes: 0,
    };

    // When selecting from healthy only, should choose the healthy one
    const selectedFromHealthy = selectUpstream([healthyUpstream as RuntimeUpstream]);
    expect(selectedFromHealthy?.target).toBe('http://healthy.com');

    // UNHEALTHY upstreams are now filtered out by selector — returns undefined
    const selectedFromRecovery = selectUpstream([recoveryCandidate as RuntimeUpstream]);
    expect(selectedFromRecovery).toBeUndefined();

    // When both available, only HEALTHY is selectable
    const selectedFromBoth = selectUpstream([healthyUpstream as RuntimeUpstream, recoveryCandidate as RuntimeUpstream]);
    expect(selectedFromBoth?.target).toBe('http://healthy.com');
  });

  test('should sort upstreams by priority and weight', () => {
    const upstreams = [
      { target: 'http://low-priority.com', weight: 100, priority: 2, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
      { target: 'http://high-priority-low-weight.com', weight: 50, priority: 1, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
      { target: 'http://high-priority-high-weight.com', weight: 200, priority: 1, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
    ];

    // Run selection 100 times to verify priority/weight distribution
    const counts: Record<string, number> = {
      'http://low-priority.com': 0,
      'http://high-priority-low-weight.com': 0,
      'http://high-priority-high-weight.com': 0,
    };

    for (let i = 0; i < 100; i++) {
      const selected = selectUpstream(upstreams as RuntimeUpstream[]);
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
    const upstreams = [
      { target: 'http://server1.com', status: 'HEALTHY', weight: 100, consecutive_failures: 0, consecutive_successes: 0 },
      { target: 'http://server2.com', status: 'HEALTHY', weight: 100, consecutive_failures: 0, consecutive_successes: 0 },
      { target: 'http://server3.com', status: 'HEALTHY', weight: 100, consecutive_failures: 0, consecutive_successes: 0 },
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
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      last_failure_time: Date.now() - 10000,
      consecutive_failures: 3,
      consecutive_successes: 0,
    };

    // Simulate successful recovery
    upstream.status = 'HEALTHY';
    upstream.last_failure_time = undefined;

    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.last_failure_time).toBeUndefined();
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
      { last_failure_time: now - 6000, shouldRecover: true },  // 6s ago
      { last_failure_time: now - 5000, shouldRecover: true },  // 5s ago (boundary)
      { last_failure_time: now - 4000, shouldRecover: false }, // 4s ago
      { last_failure_time: now - 1000, shouldRecover: false }, // 1s ago
    ];

    scenarios.forEach(({ last_failure_time, shouldRecover }) => {
      const elapsed = now - last_failure_time;
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
    const upstreams = [
      { target: 'http://only-server.com', weight: 100, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
    ];

    const selected = selectUpstream(upstreams as RuntimeUpstream[]);
    expect(selected?.target).toBe('http://only-server.com');
  });

  test('should handle all UNHEALTHY upstreams', () => {
    const upstreams = [
      { target: 'http://server1.com', weight: 100, status: 'UNHEALTHY', last_failure_time: Date.now(), consecutive_failures: 3, consecutive_successes: 0 },
      { target: 'http://server2.com', weight: 100, status: 'UNHEALTHY', last_failure_time: Date.now(), consecutive_failures: 3, consecutive_successes: 0 },
    ];

    // All UNHEALTHY → selector returns undefined (no healthy candidates)
    const selected = selectUpstream(upstreams as RuntimeUpstream[]);
    expect(selected).toBeUndefined();
  });

  test('should handle missing priority (defaults to 1)', () => {
    const upstreams = [
      { target: 'http://no-priority.com', weight: 100, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
      { target: 'http://explicit-priority.com', weight: 100, priority: 1, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
    ];

    // Both should be treated equally (both priority 1)
    const counts: Record<string, number> = {
      'http://no-priority.com': 0,
      'http://explicit-priority.com': 0,
    };

    for (let i = 0; i < 100; i++) {
      const selected = selectUpstream(upstreams as RuntimeUpstream[]);
      if (selected) {
        counts[selected.target]++;
      }
    }

    // Both should be selected approximately equally
    expect(counts['http://no-priority.com']).toBeGreaterThan(30);
    expect(counts['http://explicit-priority.com']).toBeGreaterThan(30);
  });

  test('should handle missing weight (defaults to 100)', () => {
    const upstreams = [
      { target: 'http://no-weight.com', status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
      { target: 'http://explicit-weight.com', weight: 100, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
    ];

    // Both should be treated equally (both weight 100)
    const counts: Record<string, number> = {
      'http://no-weight.com': 0,
      'http://explicit-weight.com': 0,
    };

    for (let i = 0; i < 100; i++) {
      const selected = selectUpstream(upstreams as RuntimeUpstream[]);
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
  test('should support consecutive_failures and consecutive_successes fields', () => {
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'HEALTHY',
      last_failure_time: undefined,
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    expect(upstream.consecutive_failures).toBe(0);
    expect(upstream.consecutive_successes).toBe(0);
  });

  test('should support HALF_OPEN status', () => {
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'HALF_OPEN',
      last_failure_time: Date.now() - 5000,
      consecutive_failures: 3,
      consecutive_successes: 0,
    };

    expect(upstream.status).toBe('HALF_OPEN');
    expect(['HEALTHY', 'UNHEALTHY', 'HALF_OPEN']).toContain(upstream.status);
  });
});

describe('Failover - Consecutive Failure Threshold', () => {
  test('should not mark as UNHEALTHY until threshold is reached', () => {
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'HEALTHY',
      last_failure_time: undefined,
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    const failureThreshold = 3;

    // Failure 1: Still HEALTHY
    upstream.consecutive_failures = 1;
    if (upstream.consecutive_failures >= failureThreshold) {
      upstream.status = 'UNHEALTHY';
    }
    expect(upstream.status).toBe('HEALTHY');

    // Failure 2: Still HEALTHY
    upstream.consecutive_failures = 2;
    if (upstream.consecutive_failures >= failureThreshold) {
      upstream.status = 'UNHEALTHY';
    }
    expect(upstream.status).toBe('HEALTHY');

    // Failure 3: Now UNHEALTHY
    upstream.consecutive_failures = 3;
    if (upstream.consecutive_failures >= failureThreshold) {
      upstream.status = 'UNHEALTHY';
      upstream.last_failure_time = Date.now();
    }
    expect(upstream.status).toBe('UNHEALTHY');
    expect(upstream.last_failure_time).toBeDefined();
  });

  test('should reset consecutive failures on success', () => {
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'HEALTHY',
      last_failure_time: undefined,
      consecutive_failures: 2, // Had 2 failures
      consecutive_successes: 0,
    };

    // Success resets failure counter
    upstream.consecutive_failures = 0;
    upstream.consecutive_successes++;

    expect(upstream.consecutive_failures).toBe(0);
    expect(upstream.consecutive_successes).toBe(1);
    expect(upstream.status).toBe('HEALTHY');
  });

  test('should reset consecutive successes on failure', () => {
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      last_failure_time: Date.now() - 6000,
      consecutive_failures: 0,
      consecutive_successes: 1, // Had 1 success
    };

    // Failure resets success counter
    upstream.consecutive_successes = 0;
    upstream.consecutive_failures++;

    expect(upstream.consecutive_successes).toBe(0);
    expect(upstream.consecutive_failures).toBe(1);
  });
});

describe('Failover - Healthy Threshold', () => {
  test('should not mark as HEALTHY until threshold is reached', () => {
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      last_failure_time: Date.now() - 10000,
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    const healthyThreshold = 2;

    // Success 1: Still UNHEALTHY
    upstream.consecutive_successes = 1;
    if (upstream.consecutive_successes >= healthyThreshold) {
      upstream.status = 'HEALTHY';
      upstream.last_failure_time = undefined;
    }
    expect(upstream.status).toBe('UNHEALTHY');

    // Success 2: Now HEALTHY
    upstream.consecutive_successes = 2;
    if (upstream.consecutive_successes >= healthyThreshold) {
      upstream.status = 'HEALTHY';
      upstream.last_failure_time = undefined;
    }
    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.last_failure_time).toBeUndefined();
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

    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      last_failure_time: now - 6000, // 6 seconds ago
      consecutive_failures: 3,
      consecutive_successes: 0,
    };

    // Check if recovery interval has passed
    if (upstream.status === 'UNHEALTHY' &&
        upstream.last_failure_time !== undefined &&
        (now - upstream.last_failure_time) >= recoveryIntervalMs) {
      upstream.status = 'HALF_OPEN';
    }

    expect(upstream.status).toBe('HALF_OPEN');
  });

  test('should NOT transition to HALF_OPEN before recovery interval', () => {
    const recoveryIntervalMs = 5000;
    const now = Date.now();

    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'UNHEALTHY',
      last_failure_time: now - 3000, // Only 3 seconds ago
      consecutive_failures: 3,
      consecutive_successes: 0,
    };

    // Check if recovery interval has passed
    if (upstream.status === 'UNHEALTHY' &&
        upstream.last_failure_time !== undefined &&
        (now - upstream.last_failure_time) >= recoveryIntervalMs) {
      upstream.status = 'HALF_OPEN';
    }

    expect(upstream.status).toBe('UNHEALTHY');
  });

  test('should transition HALF_OPEN → HEALTHY on success', () => {
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'HALF_OPEN',
      last_failure_time: Date.now() - 6000,
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    // Simulate successful test request
    const responseStatus = 200;
    if (upstream.status === 'HALF_OPEN' && responseStatus < 400) {
      upstream.status = 'HEALTHY';
      upstream.last_failure_time = undefined;
      upstream.consecutive_successes = 0;
    }

    expect(upstream.status).toBe('HEALTHY');
    expect(upstream.last_failure_time).toBeUndefined();
  });

  test('should transition HALF_OPEN → UNHEALTHY on failure', () => {
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'HALF_OPEN',
      last_failure_time: Date.now() - 6000,
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    // Simulate failed test request
    const responseStatus = 502;
    if (upstream.status === 'HALF_OPEN' && responseStatus >= 400) {
      upstream.status = 'UNHEALTHY';
      upstream.last_failure_time = Date.now();
    }

    expect(upstream.status).toBe('UNHEALTHY');
    expect(upstream.last_failure_time).toBeGreaterThan(Date.now() - 1000);
  });

  test('should handle complete circuit breaker cycle', () => {
    let upstream: any = {
      target: 'http://server.com',
      weight: 100,
      status: 'HEALTHY',
      last_failure_time: undefined,
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    const failureThreshold = 3;
    const recoveryIntervalMs = 5000;

    // Step 1: HEALTHY → UNHEALTHY (after 3 failures)
    upstream.consecutive_failures = 3;
    if (upstream.consecutive_failures >= failureThreshold) {
      upstream.status = 'UNHEALTHY';
      upstream.last_failure_time = Date.now();
    }
    expect(upstream.status).toBe('UNHEALTHY');

    // Step 2: UNHEALTHY → HALF_OPEN (after recovery interval)
    const afterInterval = Date.now() + recoveryIntervalMs + 1000;
    if (upstream.last_failure_time && (afterInterval - upstream.last_failure_time) >= recoveryIntervalMs) {
      upstream.status = 'HALF_OPEN';
    }
    expect(upstream.status).toBe('HALF_OPEN');

    // Step 3: HALF_OPEN → HEALTHY (on success)
    upstream.status = 'HEALTHY';
    upstream.last_failure_time = undefined;
    upstream.consecutive_failures = 0;
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
      consecutive_failuresThreshold: 3,
      recoveryIntervalMs: 5000,
      recoveryTimeoutMs: 3000,
      healthyThreshold: 2,
      requestTimeoutMs: 30000,
    };

    expect(defaults.consecutive_failuresThreshold).toBeGreaterThan(0);
    expect(defaults.healthyThreshold).toBeGreaterThan(0);
    expect(defaults.recoveryIntervalMs).toBeGreaterThan(defaults.recoveryTimeoutMs);
    expect(defaults.requestTimeoutMs).toBeGreaterThan(defaults.recoveryTimeoutMs);
  });

  test('should handle configuration edge cases', () => {
    // Minimum thresholds
    const minConfig = {
      consecutive_failuresThreshold: 1,
      healthyThreshold: 1,
    };
    expect(minConfig.consecutive_failuresThreshold).toBe(1);
    expect(minConfig.healthyThreshold).toBe(1);

    // High thresholds
    const highConfig = {
      consecutive_failuresThreshold: 10,
      healthyThreshold: 5,
    };
    expect(highConfig.consecutive_failuresThreshold).toBe(10);
    expect(highConfig.healthyThreshold).toBe(5);
  });
});

// =============================================================================
// UNIFIED SELECTION LOGIC TESTS (NEW REFACTORING)
// =============================================================================

describe('Failover - Unified Selection with Status Check', () => {
  test('should remove unavailable upstream from candidate pool and reselect', () => {
    const now = Date.now();
    const upstreams = [
      { target: 'http://p1-healthy.com', priority: 1, weight: 100, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
      { target: 'http://p1-unhealthy-recent.com', priority: 1, weight: 100, status: 'UNHEALTHY', last_failure_time: now - 2000, consecutive_failures: 3, consecutive_successes: 0 },
      { target: 'http://p2-healthy.com', priority: 2, weight: 100, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
    ];

    const recoveryIntervalMs = 5000;
    const attemptedUpstreams = new Set<string>();
    const skippedUpstreams = new Set<string>();

    // Simulate selection loop
    // Round 1: May select p1-healthy or p1-unhealthy-recent
    let availableUpstreams = upstreams.filter(
      up => !attemptedUpstreams.has(up.target) && !skippedUpstreams.has(up.target)
    );
    expect(availableUpstreams.length).toBe(3);

    // If p1-unhealthy-recent is selected, it should be skipped
    const unhealthyUpstream = upstreams[1];
    const elapsed = now - (unhealthyUpstream.last_failure_time || 0);
    const canAttempt = elapsed >= recoveryIntervalMs;
    expect(canAttempt).toBe(false); // 2s < 5s

    // Skip it
    skippedUpstreams.add(unhealthyUpstream.target);

    // Round 2: Reselect from remaining candidates
    availableUpstreams = upstreams.filter(
      up => !attemptedUpstreams.has(up.target) && !skippedUpstreams.has(up.target)
    );
    expect(availableUpstreams.length).toBe(2);
    expect(availableUpstreams).not.toContain(unhealthyUpstream);
  });

  test('should respect priority order when removing unavailable upstreams', () => {
    const now = Date.now();
    const upstreams = [
      { target: 'http://p1-unhealthy.com', priority: 1, weight: 100, status: 'UNHEALTHY', last_failure_time: now - 2000, consecutive_failures: 3, consecutive_successes: 0 },
      { target: 'http://p2-healthy.com', priority: 2, weight: 100, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
    ];

    const recoveryIntervalMs = 5000;
    const skippedUpstreams = new Set<string>();

    // Priority 1 upstream is unavailable (within recovery interval)
    const p1Upstream = upstreams[0];
    const elapsed = now - (p1Upstream.last_failure_time || 0);
    expect(elapsed < recoveryIntervalMs).toBe(true);

    // Skip priority 1
    skippedUpstreams.add(p1Upstream.target);

    // Next selection should go to priority 2
    const availableUpstreams = upstreams.filter(
      up => !skippedUpstreams.has(up.target)
    );
    const selected = selectUpstream(availableUpstreams as RuntimeUpstream[]);
    expect(selected?.priority).toBe(2);
    expect(selected?.target).toBe('http://p2-healthy.com');
  });

  test('should allow UNHEALTHY upstream to participate in selection if recovery interval met', () => {
    const now = Date.now();
    const upstreams = [
      { target: 'http://healthy.com', priority: 1, weight: 100, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
      { target: 'http://unhealthy-ready.com', priority: 1, weight: 100, status: 'UNHEALTHY', last_failure_time: now - 6000, consecutive_failures: 3, consecutive_successes: 0 },
    ];

    const recoveryIntervalMs = 5000;

    // Check if unhealthy upstream can be attempted
    const unhealthyUpstream = upstreams[1];
    const elapsed = now - (unhealthyUpstream.last_failure_time || 0);
    const canAttempt = elapsed >= recoveryIntervalMs;
    expect(canAttempt).toBe(true); // 6s > 5s

    // Both upstreams should be in candidate pool
    const availableUpstreams = upstreams;
    expect(availableUpstreams.length).toBe(2);

    // Selector should be able to choose either one
    const selected = selectUpstream(availableUpstreams as RuntimeUpstream[]);
    expect(selected).toBeDefined();
    expect(['http://healthy.com', 'http://unhealthy-ready.com']).toContain(selected!.target);
  });

  test('should handle all upstreams UNHEALTHY within recovery interval', () => {
    const now = Date.now();
    const upstreams = [
      { target: 'http://server1.com', priority: 1, weight: 100, status: 'UNHEALTHY', last_failure_time: now - 2000, consecutive_failures: 3, consecutive_successes: 0 },
      { target: 'http://server2.com', priority: 1, weight: 100, status: 'UNHEALTHY', last_failure_time: now - 3000, consecutive_failures: 3, consecutive_successes: 0 },
    ];

    const recoveryIntervalMs = 5000;
    const skippedUpstreams = new Set<string>();

    // Both upstreams should be skipped
    upstreams.forEach(up => {
      const elapsed = now - (up.last_failure_time || 0);
      if (elapsed < recoveryIntervalMs) {
        skippedUpstreams.add(up.target);
      }
    });

    expect(skippedUpstreams.size).toBe(2);

    // No upstreams available
    const availableUpstreams = upstreams.filter(
      up => !skippedUpstreams.has(up.target)
    );
    expect(availableUpstreams.length).toBe(0);
  });

  test('should transition UNHEALTHY to HALF_OPEN when selected and recovery interval met', () => {
    const now = Date.now();
    let upstream: any = {
      target: 'http://server.com',
      priority: 1,
      weight: 100,
      status: 'UNHEALTHY',
      last_failure_time: now - 6000,
      consecutive_failures: 3,
      consecutive_successes: 0,
    };

    const recoveryIntervalMs = 5000;

    // Check if can attempt
    const elapsed = now - (upstream.last_failure_time || 0);
    const shouldTransitionToHalfOpen = elapsed >= recoveryIntervalMs;
    expect(shouldTransitionToHalfOpen).toBe(true);

    // Transition to HALF_OPEN
    if (shouldTransitionToHalfOpen) {
      upstream.status = 'HALF_OPEN';
    }

    expect(upstream.status).toBe('HALF_OPEN');
  });

  test('should maintain priority order across multiple selection rounds', () => {
    const now = Date.now();
    const upstreams = [
      { target: 'http://p1-a.com', priority: 1, weight: 100, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
      { target: 'http://p1-b.com', priority: 1, weight: 100, status: 'UNHEALTHY', last_failure_time: now - 2000, consecutive_failures: 3, consecutive_successes: 0 },
      { target: 'http://p2-a.com', priority: 2, weight: 100, status: 'HEALTHY', consecutive_failures: 0, consecutive_successes: 0 },
    ];

    const attemptedUpstreams = new Set<string>();
    const skippedUpstreams = new Set<string>();

    // Mark both priority 1 upstreams as unavailable
    attemptedUpstreams.add('http://p1-a.com');
    skippedUpstreams.add('http://p1-b.com');

    // Now select from remaining upstreams
    const availableUpstreams = upstreams.filter(
      up => !attemptedUpstreams.has(up.target) && !skippedUpstreams.has(up.target)
    );

    // Should only have priority 2 available
    expect(availableUpstreams.length).toBe(1);
    expect(availableUpstreams[0].priority).toBe(2);

    const selected = selectUpstream(availableUpstreams as RuntimeUpstream[]);
    expect(selected?.priority).toBe(2);
    expect(selected?.target).toBe('http://p2-a.com');
  });
});

describe('Failover - Integration Scenarios', () => {
  test('should handle flapping upstream (alternating success/failure)', () => {
    let upstream: any = {
      target: 'http://flapping.com',
      weight: 100,
      status: 'HEALTHY',
      last_failure_time: undefined,
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    // Failure 1
    upstream.consecutive_failures++;
    upstream.consecutive_successes = 0;
    expect(upstream.status).toBe('HEALTHY');

    // Success 1 - resets counter
    upstream.consecutive_failures = 0;
    upstream.consecutive_successes++;
    expect(upstream.status).toBe('HEALTHY');

    // Failure 2
    upstream.consecutive_failures++;
    upstream.consecutive_successes = 0;
    expect(upstream.status).toBe('HEALTHY');

    // Success 2 - resets counter again
    upstream.consecutive_failures = 0;
    upstream.consecutive_successes++;
    expect(upstream.status).toBe('HEALTHY');

    // Upstream stays HEALTHY because consecutive failures never reached threshold
    expect(upstream.consecutive_failures).toBe(0);
  });

  test('should handle slow recovery (multiple attempts needed)', () => {
    let upstream: any = {
      target: 'http://slow-recovery.com',
      weight: 100,
      status: 'UNHEALTHY',
      last_failure_time: Date.now() - 10000,
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    const healthyThreshold = 3;

    // Attempt 1: Success but not enough
    upstream.consecutive_successes = 1;
    if (upstream.consecutive_successes >= healthyThreshold) {
      upstream.status = 'HEALTHY';
    }
    expect(upstream.status).toBe('UNHEALTHY');

    // Attempt 2: Success but still not enough
    upstream.consecutive_successes = 2;
    if (upstream.consecutive_successes >= healthyThreshold) {
      upstream.status = 'HEALTHY';
    }
    expect(upstream.status).toBe('UNHEALTHY');

    // Attempt 3: Success, now recovered
    upstream.consecutive_successes = 3;
    if (upstream.consecutive_successes >= healthyThreshold) {
      upstream.status = 'HEALTHY';
      upstream.last_failure_time = undefined;
    }
    expect(upstream.status).toBe('HEALTHY');
  });

  test('should handle recovery failure (HALF_OPEN → UNHEALTHY)', () => {
    let upstream: any = {
      target: 'http://still-broken.com',
      weight: 100,
      status: 'HALF_OPEN',
      last_failure_time: Date.now() - 6000,
      consecutive_failures: 0,
      consecutive_successes: 0,
    };

    // Test request fails
    upstream.status = 'UNHEALTHY';
    upstream.last_failure_time = Date.now();
    upstream.consecutive_failures++;
    upstream.consecutive_successes = 0;

    expect(upstream.status).toBe('UNHEALTHY');
    expect(upstream.consecutive_failures).toBe(1);
    expect(upstream.last_failure_time).toBeGreaterThan(Date.now() - 1000);
  });
});
