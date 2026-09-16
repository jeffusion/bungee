export type TestPortBlock = {
  readonly basePort: number;
  readonly ports: readonly [number, number, number];
};

export type TestPortBlockState = 'active' | 'quarantined';
export type TestPortBlockScope = { readonly portBlocks: Set<TestPortBlock> };

const states = new Map<number, TestPortBlockState>();

export function makeTestPortBlock(basePort: number): TestPortBlock {
  return { basePort, ports: [basePort, basePort + 1, basePort + 2] };
}

export function testPortBlocksOverlap(left: TestPortBlock, right: TestPortBlock): boolean {
  return left.ports.some((port) => right.ports.includes(port));
}

export function claimTestPortBlock(block: TestPortBlock): boolean {
  if (testPortBlockOverlapsClaimed(block)) return false;
  states.set(block.basePort, 'active');
  return true;
}

export function testPortBlockOverlapsClaimed(block: TestPortBlock): boolean {
  for (const basePort of states.keys()) {
    if (testPortBlocksOverlap(block, makeTestPortBlock(basePort))) return true;
  }
  return false;
}

export function quarantineAndDetach(scope: TestPortBlockScope, block: TestPortBlock): boolean {
  const reported = states.get(block.basePort) !== 'quarantined';
  states.set(block.basePort, 'quarantined');
  scope.portBlocks.delete(block);
  return reported;
}

export function releaseTestPortBlock(block: TestPortBlock): boolean {
  if (states.get(block.basePort) !== 'active') return false;
  states.delete(block.basePort);
  return true;
}

export function testPortBlockState(block: TestPortBlock): TestPortBlockState | undefined {
  return states.get(block.basePort);
}
