import { expect, test } from 'bun:test';
import {
  createTestPortBlockBroker,
  ensureTestPortBlockClosed,
  makeTestPortBlock,
  testPortBlocksOverlap,
} from './test-port-block-broker';

test('tracks and probes all four reserved ports', async () => {
  const block = makeTestPortBlock(41_000);
  const probed: number[] = [];
  expect(block.ports).toEqual([41_000, 41_001, 41_002, 41_003]);
  await ensureTestPortBlockClosed(block, { probe: async (port) => { probed.push(port); return 'closed'; } });
  expect(probed.sort((left, right) => left - right)).toEqual([...block.ports]);
});

test('rejects overlap on the fourth port', () => {
  const broker = createTestPortBlockBroker();
  const block = makeTestPortBlock(41_100);
  expect(broker.claim(block)).toBeTrue();
  try {
    expect(testPortBlocksOverlap(block, makeTestPortBlock(block.ports[3]))).toBeTrue();
    expect(broker.claim(makeTestPortBlock(block.ports[3]))).toBeFalse();
  } finally {
    expect(broker.release(block)).toBeTrue();
  }
});

test('isolates broker state without releasing quarantined leases', () => {
  const first = createTestPortBlockBroker();
  const second = createTestPortBlockBroker();
  const block = makeTestPortBlock(41_100);
  expect(first.claim(block)).toBeTrue();
  expect(second.claim(block)).toBeTrue();
  expect(first.quarantine(block)).toBeTrue();
  expect(first.quarantine(block)).toBeFalse();
  expect(first.state(block)).toBe('quarantined');
  expect(first.release(block)).toBeFalse();
  expect(first.overlapsClaimed(makeTestPortBlock(block.ports[3]))).toBeTrue();
  expect(first.claim(block)).toBeFalse();
  expect(second.release(block)).toBeTrue();
  expect(second.state(block)).toBeUndefined();
  expect(second.claim(block)).toBeTrue();
  expect(second.release(block)).toBeTrue();
});
