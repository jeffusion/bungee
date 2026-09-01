import type { Database, SQLQueryBindings } from 'bun:sqlite';

export function sqliteAll<Row, Params extends SQLQueryBindings[]>(
  db: Database,
  sql: string,
  ...params: Params
): Row[] {
  const statement = db.prepare<Row, SQLQueryBindings[]>(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

export function sqliteGet<Row, Params extends SQLQueryBindings[]>(
  db: Database,
  sql: string,
  ...params: Params
): Row | null {
  const statement = db.prepare<Row, SQLQueryBindings[]>(sql);
  try {
    return statement.get(...params);
  } finally {
    statement.finalize();
  }
}
