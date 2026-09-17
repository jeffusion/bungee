import { Database } from 'bun:sqlite';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LogQueryService } from '../../src/api/logs';
import type { MasterFixture, RunningMaster } from './master-real-process-harness';

export const STATS_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function statsAggregate(upstreamPort: number): ConfigurationAggregateV2 {
  return {
    plugin_activations: [],
    logical_configuration: {
      auth: { enabled: true, tokens: [STATS_TOKEN] },
      services: [{
        id: '73000000-0000-4000-8000-000000000001', position: 1, name: 'stats-upstream', plugins: [],
        endpoints: [{
          id: '73000000-0000-4000-8000-000000000002', position: 1,
          target: `http://127.0.0.1:${upstreamPort}`, weight: 100, priority: 1, is_disabled: false, plugins: [],
        }],
      }],
      routes: [{
        id: '73000000-0000-4000-8000-000000000003', position: 1, path: '/proxy',
        service_id: '73000000-0000-4000-8000-000000000001', auth: { enabled: false, tokens: [] }, plugins: [],
      }],
      plugins: [],
    },
  };
}

export async function withAccessLogQuery<T>(
  fixture: MasterFixture,
  query: (logs: LogQueryService, database: Database) => Promise<T>,
): Promise<T> {
  const database = new Database(fixture.accessDbPath, { readonly: true, strict: true });
  try {
    database.run('PRAGMA busy_timeout = 5000');
    return await query(new LogQueryService(database), database);
  } finally {
    database.close();
  }
}

export async function preserveMasterStatsFailure(
  master: RunningMaster | undefined,
  evidence: unknown,
): Promise<void> {
  const root = join('/tmp/opencode', `master-stats-real-process-${Date.now()}`);
  const redact = (value: string): string => value.replaceAll(STATS_TOKEN, '[REDACTED]');
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'master.log'), redact(master?.output() ?? 'master was not spawned'), 'utf8'),
    writeFile(join(root, 'operation.json'), redact(JSON.stringify(evidence, null, 2)), 'utf8'),
    writeFile(join(root, 'source-identifiers.json'), JSON.stringify({
      test: 'tests/integration/master-stats-real-process.test.ts',
      fixture: 'tests/fixtures/master-stats-real-process.fixture.ts',
      master: 'src/master.ts',
      stats: 'src/master-runtime/master-stats.ts',
    }, null, 2), 'utf8'),
  ]);
}
