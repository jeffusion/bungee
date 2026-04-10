import { Database } from 'bun:sqlite';
import { resolve } from 'path';

const DB_PATH = resolve(import.meta.dir, '../logs/access.db');
const PLUGIN_NAME = 'token-stats';
const STORAGE_NAMESPACE = 'token-stats:v2:';

const ROUTES = [
  'openai-chat',
  'claude-api',
  'gemini-pro',
  'deepseek-coder',
  'qwen-turbo',
];

const UPSTREAMS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
  'dashscope.aliyuncs.com',
];

type GroupByDimension = 'all' | 'route' | 'upstream' | 'provider';

interface AggregateRow {
  inputTokens: number;
  outputTokens: number;
  logicalRequests: number;
  upstreamAttempts: number;
  officialInputTokens: number;
  officialOutputTokens: number;
  partialOutputs: number;
  inputAuthorityOfficial: number;
  inputAuthorityLocal: number;
  inputAuthorityHeuristic: number;
  inputAuthorityPartial: number;
  inputAuthorityNone: number;
  outputAuthorityOfficial: number;
  outputAuthorityLocal: number;
  outputAuthorityHeuristic: number;
  outputAuthorityPartial: number;
  outputAuthorityNone: number;
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getUtcHourBucket(date: Date): string {
  return date.toISOString().slice(0, 13);
}

function createStorageKey(groupBy: GroupByDimension, dimension: string, bucket: string): string {
  return `${STORAGE_NAMESPACE}${groupBy}:${encodeURIComponent(dimension)}:${bucket}`;
}

function createRow(inputTokens: number, outputTokens: number, logicalRequests: number, upstreamAttempts: number): AggregateRow {
  return {
    inputTokens,
    outputTokens,
    logicalRequests,
    upstreamAttempts,
    officialInputTokens: inputTokens,
    officialOutputTokens: outputTokens,
    partialOutputs: 0,
    inputAuthorityOfficial: logicalRequests,
    inputAuthorityLocal: 0,
    inputAuthorityHeuristic: 0,
    inputAuthorityPartial: 0,
    inputAuthorityNone: 0,
    outputAuthorityOfficial: logicalRequests,
    outputAuthorityLocal: 0,
    outputAuthorityHeuristic: 0,
    outputAuthorityPartial: 0,
    outputAuthorityNone: 0,
  };
}

async function seedData() {
  console.log(`Opening database: ${DB_PATH}`);
  const db = new Database(DB_PATH);

  db.run(`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      plugin_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      ttl INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_name, key)
    )
  `);

  const now = Math.floor(Date.now() / 1000) * 1000;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
    VALUES (?, ?, ?, NULL, ?)
  `);

  let count = 0;

  for (let hoursAgo = 0; hoursAgo < 24; hoursAgo++) {
    const date = new Date();
    date.setHours(date.getHours() - hoursAgo);
    const bucket = getUtcHourBucket(date);

    for (let i = 0; i < ROUTES.length; i++) {
      const routeId = ROUTES[i];
      const upstreamId = UPSTREAMS[i];
      const provider = routeId.includes('claude') ? 'anthropic' : routeId.includes('gemini') ? 'gemini' : 'openai';

      const inputTokens = Math.max(0, randomBetween(500, 5000) * (i + 1) + randomBetween(-500, 500));
      const outputTokens = Math.max(0, randomBetween(200, 2000) * (i + 1) + randomBetween(-200, 200));
      const logicalRequests = randomBetween(5, 50) * (i + 1);
      const upstreamAttempts = logicalRequests + randomBetween(0, 10);

      const row = createRow(inputTokens, outputTokens, logicalRequests, upstreamAttempts);
      const entries: Array<[GroupByDimension, string, AggregateRow]> = [
        ['all', 'all', row],
        ['route', routeId, row],
        ['upstream', upstreamId, row],
        ['provider', provider, row],
      ];

      for (const [groupBy, dimension, value] of entries) {
        stmt.run(PLUGIN_NAME, createStorageKey(groupBy, dimension, bucket), JSON.stringify(value), now);
        count++;
      }
    }
  }

  db.close();
  console.log(`✅ 已生成 ${count} 条测试数据`);
  console.log(`   - 路由: ${ROUTES.join(', ')}`);
  console.log(`   - Upstream: ${UPSTREAMS.join(', ')}`);
  console.log(`   - 命名空间: ${STORAGE_NAMESPACE}`);
  console.log(`   - 时间范围: 过去 24 小时`);
}

seedData().catch(console.error);
