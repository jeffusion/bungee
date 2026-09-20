import { expect, test } from 'bun:test';
import {
  claimTestPortBlock,
  ensureTestPortBlockClosed,
  makeTestPortBlock,
  releaseTestPortBlock,
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
  const block = makeTestPortBlock(41_100);
  expect(claimTestPortBlock(block)).toBeTrue();
  try {
    expect(testPortBlocksOverlap(block, makeTestPortBlock(block.ports[3]))).toBeTrue();
    expect(claimTestPortBlock(makeTestPortBlock(block.ports[3]))).toBeFalse();
  } finally {
    expect(releaseTestPortBlock(block)).toBeTrue();
  }
});
