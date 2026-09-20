import type { Database } from 'bun:sqlite';

export function withConsistentRead<Result>(db: Database, fn: () => Result): Result {
  if (db.inTransaction) return fn();
  return db.transaction(fn).deferred();
}
