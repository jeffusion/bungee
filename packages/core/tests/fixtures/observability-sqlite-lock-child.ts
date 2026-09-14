import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

const [databasePath, mode, barrierPath] = Bun.argv.slice(2);

function report(event: string): void {
  process.stdout.write(`${JSON.stringify({ event })}\n`);
}

async function waitForInput(expected: string): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    const chunk = value;
    if (new TextDecoder().decode(chunk).includes(expected)) return;
  }
}

async function waitForFile(filePath: string): Promise<void> {
  while (!existsSync(filePath)) await Bun.sleep(5);
}

if (databasePath === undefined || mode === undefined) throw new Error('database path and mode are required');

if (mode === 'lock') {
  const database = new Database(databasePath);
  database.run('PRAGMA busy_timeout = 50');
  database.run('BEGIN EXCLUSIVE');
  report('LOCK_READY');
  await waitForInput('release');
  database.run('ROLLBACK');
  database.close();
  report('LOCK_RELEASED');
} else if (mode === 'writer') {
  process.env.BUNGEE_ACCESS_DB_PATH = `${databasePath}.child-singleton`;
  const { AccessLogWriter, accessLogWriter } = await import('../../src/logger/access-log-writer');
  const writer = new AccessLogWriter(databasePath);
  writer.getDatabase().run('PRAGMA busy_timeout = 50');
  report('WRITER_READY');
  if (barrierPath === undefined) throw new Error('writer barrier is required');
  await waitForFile(barrierPath);
  writer.write({
    requestId: `child-${process.pid}`, timestamp: Date.now(), method: 'GET', path: '/child',
    status: 200, duration: 1, success: true, authSuccess: true,
  });
  try {
    let busy = false;
    try {
      await writer.flush();
    } catch (error) {
      const code = String((error as { code?: unknown }).code ?? '');
      if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') throw error;
      busy = true;
    }
    if (!busy) throw new Error('writer flush unexpectedly succeeded while lock was held');
    report('WRITE_BUSY');
    await waitForInput('retry');
    await writer.flush();
    report('WRITE_DONE');
  } finally {
    await writer.close();
    await accessLogWriter.close();
  }
} else {
  throw new Error(`unknown mode: ${mode}`);
}
