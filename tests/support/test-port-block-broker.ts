import { connect as connectTcp } from 'node:net';

export type TestPortBlock = {
  readonly basePort: number;
  readonly ports: readonly [number, number, number, number];
};

export type TestPortBlockState = 'active' | 'quarantined';
export type TestPortBlockScope = { readonly portBlocks: Set<TestPortBlock> };
export type TestTcpPortState = 'open' | 'closed' | 'unknown';
export type TestPortBlockCloseOptions = {
  readonly probe?: (port: number) => Promise<TestTcpPortState>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
};

const states = new Map<number, TestPortBlockState>();
const PORT_BLOCK_CLOSE_DEADLINE_MS = 1_000;
const PORT_BLOCK_CLOSE_POLL_MS = 25;
export const TEST_PORT_BLOCK_CLOSE_ERROR = 'test port block physical close deadline exceeded';

export function makeTestPortBlock(basePort: number): TestPortBlock {
  return { basePort, ports: [basePort, basePort + 1, basePort + 2, basePort + 3] };
}

export function testPortBlocksOverlap(left: TestPortBlock, right: TestPortBlock): boolean {
  return left.ports.some((port) => right.ports.includes(port));
}

export function claimTestPortBlock(block: TestPortBlock): boolean {
  if (testPortBlockOverlapsClaimed(block)) return false;
  states.set(block.basePort, 'active');
  return true;
}

export function quarantineTestPortBlock(block: TestPortBlock): boolean {
  const reported = states.get(block.basePort) !== 'quarantined';
  states.set(block.basePort, 'quarantined');
  return reported;
}

export function testPortBlockOverlapsClaimed(block: TestPortBlock): boolean {
  for (const basePort of states.keys()) {
    if (testPortBlocksOverlap(block, makeTestPortBlock(basePort))) return true;
  }
  return false;
}

export function quarantineAndDetach(scope: TestPortBlockScope, block: TestPortBlock): boolean {
  const reported = quarantineTestPortBlock(block);
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

export function probeTestTcpPort(port: number, timeoutMs = 100): Promise<TestTcpPortState> {
  return new Promise((resolve) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (state: TestTcpPortState): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(state);
    };
    socket.once('connect', () => finish('open'));
    socket.once('error', (error: unknown) => finish(error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
    socket.setTimeout(timeoutMs, () => finish('unknown'));
    timer = setTimeout(() => finish('unknown'), timeoutMs);
  });
}

export async function ensureTestPortBlockClosed(
  block: TestPortBlock,
  options: TestPortBlockCloseOptions = {},
): Promise<void> {
  const probe = options.probe ?? probeTestTcpPort;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() + PORT_BLOCK_CLOSE_DEADLINE_MS;
  for (;;) {
    const states = await Promise.all(block.ports.map(async (port) => {
      try { return await probe(port); }
      catch { return 'unknown' as const; }
    }));
    if (states.every((state) => state === 'closed')) return;
    const remaining = deadline - now();
    if (remaining <= 0) {
      quarantineTestPortBlock(block);
      throw new Error(TEST_PORT_BLOCK_CLOSE_ERROR);
    }
    await sleep(Math.min(PORT_BLOCK_CLOSE_POLL_MS, remaining));
  }
}
