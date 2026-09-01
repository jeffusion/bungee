import { describe, expect, test } from 'bun:test';
import {
  assertSupportedSqliteVersion,
  readSqliteVersion,
  SqliteVersionError,
} from '../../src/config-storage/sqlite-version';
import { Database } from 'bun:sqlite';

describe('sqlite-version gate', () => {
  test('accepts documented supported versions', () => {
    expect(() => assertSupportedSqliteVersion('3.53.0')).not.toThrow();
    expect(() => assertSupportedSqliteVersion('3.51.3')).not.toThrow();
    expect(() => assertSupportedSqliteVersion('3.50.7')).not.toThrow();
    expect(() => assertSupportedSqliteVersion('3.44.6')).not.toThrow();
    expect(() => assertSupportedSqliteVersion('3.44.99')).not.toThrow();
    expect(() => assertSupportedSqliteVersion('3.52.0')).not.toThrow();
  });

  test('rejects documented blocked versions', () => {
    expect(() => assertSupportedSqliteVersion('3.0.0')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.20.0')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.43.99')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.51.0')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.51.1')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.51.2')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.45.0')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.45.99')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.49.0')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.44.6-suffix')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.44.6\n')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('3.44')).toThrow(SqliteVersionError);
    expect(() => assertSupportedSqliteVersion('4.0.0')).toThrow(SqliteVersionError);
  });

  test('reads version from a live sqlite database', () => {
    const db = new Database(':memory:');
    const version = readSqliteVersion(db);
    expect(version).toMatch(/^3\.\d+\.\d+/);
    db.close();
  });
});
