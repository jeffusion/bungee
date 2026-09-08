import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { canonicalJson } from './content-hash';
import { CONFIG_MIGRATION_V1 } from './migrations/v1';
import { CONFIG_MIGRATION_V2 } from './migrations/v2';
import { CONFIG_MIGRATION_V3 } from './migrations/v3';
import { CONFIG_MIGRATION_V4 } from './migrations/v4';
import { CONFIG_MIGRATION_V5 } from './migrations/v5';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll } from './sqlite-query';

type SchemaRow = { readonly name: string; readonly sql: string | null };
type TableListRow = { readonly name: string; readonly type: string; readonly ncol: number; readonly wr: number; readonly strict: number };
type ColumnRow = {
  readonly cid: number; readonly name: string; readonly type: string; readonly notnull: number;
  readonly dflt_value: string | null; readonly pk: number; readonly hidden: number;
};
type ForeignKeyRow = {
  readonly id: number; readonly seq: number; readonly table: string; readonly from: string; readonly to: string;
  readonly on_update: string; readonly on_delete: string; readonly match: string;
};
type IndexRow = { readonly name: string; readonly unique: number; readonly origin: string; readonly partial: number };
type IndexColumnRow = {
  readonly seqno: number; readonly cid: number; readonly name: string | null;
  readonly desc: number; readonly coll: string; readonly key: number;
};

function pragmaName(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

function normalizedSql(sql: string | null): string {
  return (sql ?? '').trim();
}

function indexDescriptor(db: Database, table: string): readonly unknown[] {
  const indexes = sqliteAll<IndexRow, [string]>(db, 'SELECT name,"unique",origin,partial FROM pragma_index_list(?)', table);
  return indexes.map((index) => ({
    unique: index.unique,
    origin: index.origin,
    partial: index.partial,
    columns: sqliteAll<IndexColumnRow, SQLQueryBindings[]>(
      db,
      `PRAGMA index_xinfo(${pragmaName(index.name)})`,
    ).map(({ seqno, cid, name, desc, coll, key }) => ({ seqno, cid, name, desc, coll, key })),
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function schemaDescriptor(db: Database): string {
  const definitions = new Map(sqliteAll<SchemaRow, []>(db, `SELECT name,sql FROM sqlite_schema
    WHERE type='table' AND name NOT LIKE 'sqlite_%'`).map((row) => [row.name, row.sql]));
  const tables = sqliteAll<TableListRow, []>(db, `SELECT name,type,ncol,wr,strict FROM pragma_table_list
    WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const objects = sqliteAll<SchemaRow & { readonly type: string; readonly tbl_name: string }, []>(db, `SELECT type,name,tbl_name,sql
    FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).map((row) => ({
      type: row.type, name: row.name, table: row.tbl_name, sql: normalizedSql(row.sql),
    }));
  return canonicalJson({
    objects,
    tables: tables.map((table) => ({
      name: table.name,
      type: table.type,
      ncol: table.ncol,
      wr: table.wr,
      strict: table.strict,
      sql: normalizedSql(definitions.get(table.name) ?? null),
      columns: sqliteAll<ColumnRow, [string]>(db, `SELECT cid,name,type,"notnull",dflt_value,pk,hidden
        FROM pragma_table_xinfo(?) ORDER BY cid`, table.name),
      foreignKeys: sqliteAll<ForeignKeyRow, [string]>(db, `SELECT id,seq,"table","from","to",on_update,on_delete,"match"
        FROM pragma_foreign_key_list(?) ORDER BY id,seq`, table.name),
      indexes: indexDescriptor(db, table.name),
    })),
  });
}

const expectedDescriptors = new Map<number, string>();
const CONFIG_MIGRATIONS = [
  CONFIG_MIGRATION_V1,
  CONFIG_MIGRATION_V2,
  CONFIG_MIGRATION_V3,
  CONFIG_MIGRATION_V4,
  CONFIG_MIGRATION_V5,
] as const;

function getExpectedDescriptor(version: number): string {
  const cached = expectedDescriptors.get(version);
  if (cached !== undefined) return cached;
  const expected = new Database(':memory:', { create: true, readwrite: true, strict: true });
  try {
    for (const migration of CONFIG_MIGRATIONS.slice(0, version)) migration.up(expected);
    const descriptor = schemaDescriptor(expected);
    expectedDescriptors.set(version, descriptor);
    return descriptor;
  } finally {
    expected.close(true);
  }
}

export function verifySchemaFingerprint(db: Database, version: number = CONFIG_MIGRATIONS.length): void {
  if (schemaDescriptor(db) !== getExpectedDescriptor(version)) {
    throw new ConfigRepositoryError('schema_corrupt', 'configuration schema fingerprint is invalid');
  }
}
