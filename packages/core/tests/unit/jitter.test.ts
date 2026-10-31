/**
 * Jitter utility tests
 */

import { describe, test, expect } from 'bun:test';
import {
  addJitter,
  addFullJitter,
  addDecorrelatedJitter,
  exponentialBackoffWithJitter,
} from '../../src/worker/utils/jitter';

describe('Jitter - Basic Jitter', () => {
  test('should return value within jitter range', () => {
    const baseMs = 1000;
    const jitterFactor = 0.2; // 20%

    // Expected range: 800-1200ms
    const results: number[] = [];
    for (let i = 0; i < 100; i++) {
      const result = addJitter(baseMs, jitterFactor);
      results.push(result);
      expect(result).toBeGreaterThanOrEqual(800);
      expect(result).toBeLessThanOrEqual(1200);
    }

    // Check that we get distribution (not all same value)
    const unique = new Set(results);
    expect(unique.size).toBeGreaterThan(10);
  });

  test('should handle zero jitter factor', () => {
    const baseMs = 1000;
    const jitterFactor = 0;

    const result = addJitter(baseMs, jitterFactor);
    expect(result).toBe(baseMs);
  });

  test('should handle full jitter factor (1.0)', () => {
    const baseMs = 1000;
    const jitterFactor = 1.0;

    // Expected range: 0-2000ms
    for (let i = 0; i < 20; i++) {
      const result = addJitter(baseMs, jitterFactor);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(2000);
    }
  });

  test('should clamp jitter factor above 1', () => {
    const baseMs = 1000;
    const jitterFactor = 1.5; // Should be treated as 1.0

    const result = addJitter(baseMs, jitterFactor);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(2000);
  });

  test('should handle negative jitter factor as 0', () => {
    const baseMs = 1000;
    const jitterFactor = -0.5;

    const result = addJitter(baseMs, jitterFactor);
    expect(result).toBe(baseMs);
  });
});

describe('Jitter - Full Jitter', () => {
  test('should return value between 0 and max', () => {
    const maxMs = 5000;

    for (let i = 0; i < 100; i++) {
      const result = addFullJitter(maxMs);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(maxMs);
    }
  });

  test('should produce varied results', () => {
    const maxMs = 1000;
    const results: number[] = [];

    for (let i = 0; i < 50; i++) {
      results.push(addFullJitter(maxMs));
    }

    const unique = new Set(results);
    expect(unique.size).toBeGreaterThan(20);
  });
});

describe('Jitter - Decorrelated Jitter', () => {
  test('should return value >= base', () => {
    const baseMs = 1000;
    const maxMs = 30000;

    for (let i = 0; i < 20; i++) {
      const result = addDecorrelatedJitter(baseMs, maxMs);
      expect(result).toBeGreaterThanOrEqual(baseMs);
      expect(result).toBeLessThanOrEqual(maxMs);
    }
  });

  test('should use previous delay to calculate next', () => {
    const baseMs = 1000;
    const maxMs = 30000;
    const previousMs = 5000;

    for (let i = 0; i < 20; i++) {
      const result = addDecorrelatedJitter(baseMs, maxMs, previousMs);
      expect(result).toBeGreaterThanOrEqual(baseMs);
      expect(result).toBeLessThanOrEqual(maxMs);
    }
  });

  test('should respect max cap', () => {
    const baseMs = 1000;
    const maxMs = 5000;
    const previousMs = 10000; // Large previous value

    const result = addDecorrelatedJitter(baseMs, maxMs, previousMs);
    expect(result).toBeLessThanOrEqual(maxMs);
  });

  test('should use base when no previous provided', () => {
    const baseMs = 1000;
    const maxMs = 30000;

    const result = addDecorrelatedJitter(baseMs, maxMs);
    expect(result).toBeGreaterThanOrEqual(baseMs);
  });
});

describe('Jitter - Exponential Backoff', () => {
  test('should increase exponentially with attempts', () => {
    const baseMs = 1000;
    const maxMs = 30000;
    const jitterFactor = 0.2;

    const attempt0 = exponentialBackoffWithJitter(0, baseMs, maxMs, jitterFactor);
    const attempt1 = exponentialBackoffWithJitter(1, baseMs, maxMs, jitterFactor);
    const attempt2 = exponentialBackoffWithJitter(2, baseMs, maxMs, jitterFactor);

    // Attempt 0: ~1000ms (800-1200)
    expect(attempt0).toBeGreaterThanOrEqual(800);
    expect(attempt0).toBeLessThanOrEqual(1200);

    // Attempt 1: ~2000ms (1600-2400)
    expect(attempt1).toBeGreaterThanOrEqual(1600);
    expect(attempt1).toBeLessThanOrEqual(2400);

    // Attempt 2: ~4000ms (3200-4800)
    expect(attempt2).toBeGreaterThanOrEqual(3200);
    expect(attempt2).toBeLessThanOrEqual(4800);
  });

  test('should respect max cap', () => {
    const baseMs = 1000;
    const maxMs = 5000;

    // Attempt 10 would normally be 1024000ms, but should cap at 5000
    const result = exponentialBackoffWithJitter(10, baseMs, maxMs, 0.2);
    expect(result).toBeLessThanOrEqual(maxMs * 1.2); // Account for jitter
  });

  test('should handle default jitter factor', () => {
    const baseMs = 1000;
    const maxMs = 30000;

    // Should use default 0.2 jitter
    const result = exponentialBackoffWithJitter(0, baseMs, maxMs);
    expect(result).toBeGreaterThanOrEqual(800);
    expect(result).toBeLessThanOrEqual(1200);
  });
});
