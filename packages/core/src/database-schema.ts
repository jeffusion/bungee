import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { canonicalJson } from './config-storage/content-hash';
import { sqliteAll } from './config-storage/sqlite-query';
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
  return (sql ?? '').match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[^'"`\[]+/g)?.map(token => /^['"`\[]/.test(token) ? token : token.replace(/\s+/g,' ')).join('').trim() ?? '';
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

export function databaseSchemaDescriptor(db: Database): string {
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
