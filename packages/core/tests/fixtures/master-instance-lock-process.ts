import { acquireMasterInstanceLock, MasterInstanceLockError } from '../../src/master-runtime/instance-lock';

const lockPath = process.argv[2];
const waitForCommand = process.argv[3] === 'wait';
if (lockPath === undefined) throw new TypeError('lock path is required');

let lock: Awaited<ReturnType<typeof acquireMasterInstanceLock>> | null = null;
const keepAlive = setInterval(() => undefined, 60_000);

function send(message: object): void {
  if (process.send === undefined) throw new TypeError('IPC channel is required');
  process.send(message);
}

async function acquire(): Promise<void> {
  try {
    lock = await acquireMasterInstanceLock(lockPath);
    send({ status: 'acquired' });
  } catch (error) {
    if (error instanceof MasterInstanceLockError) {
      send({ status: 'failed', code: error.code });
      return;
    }
    throw error;
  }
}

process.on('SIGTERM', () => {
  clearInterval(keepAlive);
  if (lock === null) process.exit(0);
  else void lock.release().then(() => process.exit(0));
});

if (waitForCommand) {
  process.on('message', (message) => {
    if (message === 'acquire') void acquire();
  });
  send({ status: 'ready' });
} else {
  await acquire();
}
