import { expect, test } from 'bun:test';
import {
  candidateResourcesReleased,
  type ProcessCleanupResult,
} from '../../../src/config-publication/process-cleanup';

const process = {} as ProcessCleanupResult['process'];

test('a pre-ready candidate is released only by its signed cleanup record', () => {
  expect(candidateResourcesReleased([{ process, exitEvidence: { exited: true, pid: 1 } }])).toBe(false);
  expect(candidateResourcesReleased([{ process,
    exitEvidence: { exited: true, pid: 1, cleanup_state: 'failed' } }])).toBe(false);
  expect(candidateResourcesReleased([{ process,
    exitEvidence: { exited: true, pid: 1, cleanup_state: 'success' } }])).toBe(true);
  expect(candidateResourcesReleased([{ process, waitError: new Error('wait failed'),
    exitEvidence: { exited: true, pid: 1, cleanup_state: 'success' } }])).toBe(false);
  expect(candidateResourcesReleased([{ process, exitEvidence: null }])).toBe(false);
});

test('a drained worker keeps proving release through its terminal drain message', () => {
  const terminal = (cleanup_state: 'success' | 'pending') => ({ status: 'worker-drained', cleanup_state }) as any;
  expect(candidateResourcesReleased([{ process,
    exitEvidence: { exited: true, pid: 1, terminalDrain: terminal('success') } }])).toBe(true);
  expect(candidateResourcesReleased([{ process,
    exitEvidence: { exited: true, pid: 1, terminalDrain: terminal('pending') } }])).toBe(false);
  expect(candidateResourcesReleased([{ process,
    exitEvidence: { exited: true, pid: 1, terminalDrain: terminal('pending'), cleanup_state: 'success' } }])).toBe(false);
});

test('an empty ownership set never counts as released', () => {
  expect(candidateResourcesReleased([])).toBe(false);
});
