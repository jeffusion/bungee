import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './index';
import { initializeAccessDatabaseConnection } from '../access-database';
import { verifyAccessSchema } from './schema-fingerprint';
import type { Migration, MigrationRecord, MigrationResult } from './migration.types';

export function migrateAccessDatabase(db: Database, plan: readonly Migration[] = migrations): void {
  db.transaction(() => {
    if (!plan.length || plan[0] !== migrations[0] || plan.some((m,i) => !/^\d{3}$/.test(m.version) || i > 0 && Number(m.version) !== Number(plan[i-1]!.version)+1)
      || new Set(plan.map(m => m.name)).size !== plan.length) throw new Error('access_migration_plan_invalid');
    const count = db.query<{count:number},[]>("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!.count;
    let applied: MigrationRecord[] = [];
    if (count) {
      applied = db.query<MigrationRecord,[]>('SELECT version,name,applied_at FROM schema_migrations ORDER BY version').all();
      if (!applied.length || applied.length > plan.length || applied.some((r,i) => r.version !== plan[i]?.version || r.name !== plan[i]?.name)) throw new Error('access_migration_history_invalid');
      verifyAccessSchema(db,applied.at(-1)!.version,plan);
    }
    for (const migration of plan.slice(applied.length)) {
      migration.up(db);
      db.run('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)',[migration.version,migration.name,Date.now()]);
    }
    verifyAccessSchema(db,plan.at(-1)!.version,plan);
  }).immediate();
}

export class MigrationManager {
  constructor(private readonly dbPath: string) {}
  async migrate(): Promise<MigrationResult> {
    let db: Database | undefined;
    try {
      mkdirSync(dirname(this.dbPath),{recursive:true});
      db = new Database(this.dbPath,{create:true,readwrite:true,strict:true});
      initializeAccessDatabaseConnection(db);
      migrateAccessDatabase(db);
      return {success:true};
    } catch (error) {
      return {success:false,fallback:'readonly',userMessage:'数据库升级失败，日志功能以只读模式运行。',error:error instanceof Error ? error.message : String(error)};
    } finally { db?.close(true); }
  }
  async status(): Promise<Array<{version:string;name:string;applied:boolean}>> {
    if (!existsSync(this.dbPath)) return migrations.map(m => ({version:m.version,name:m.name,applied:false}));
    const db = new Database(this.dbPath,{readonly:true,strict:true});
    try {
      const records = db.query<MigrationRecord,[]>('SELECT version,name,applied_at FROM schema_migrations').all();
      return migrations.map(m => ({version:m.version,name:m.name,applied:records.some(r => r.version===m.version && r.name===m.name)}));
    } finally { db.close(); }
  }
}
