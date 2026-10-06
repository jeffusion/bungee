import { Database } from 'bun:sqlite';
import type { PluginStorage, PluginObservationStorage, PluginStorageReadResult } from './plugin.types';
import { logger } from './logger';
import { LRUCache, type LRUCacheOptions } from './plugin-storage-cache';

/**
 * 基于 SQLite 的插件存储实现
 * 每个插件实例拥有独立的存储空间（通过 pluginName 隔离）
 *
 * 特性：
 * - LRU缓存层（减少数据库访问）
 * - Write-Behind写入策略（批量写入优化）
 * - TTL过期检查
 */
export class SQLitePluginStorage implements PluginStorage {
  private db: Database;
  private pluginName: string;
  private cache: LRUCache | null = null;
  readonly observation?: PluginObservationStorage;

  /** A separate immediate KV view for values shared across processes. */
  uncached(): PluginStorage { return new SQLitePluginStorage(this.db, this.pluginName); }

  constructor(
    db: Database,
    pluginName: string,
    cacheOptions?: LRUCacheOptions
  ) {
    this.db = db;
    this.pluginName = pluginName;
    if (isObservationDatabase(db)) this.observation = Object.freeze({
      withDatabase: <T>(operation: (database: Database) => T): T => {
        return operation(db);
      },
    });

    // 如果提供了缓存选项，初始化缓存
    if (cacheOptions) {
      this.cache = new LRUCache(
        cacheOptions,
        this.writeBackToDb.bind(this)
      );
      logger.debug(
        { pluginName, cacheOptions },
        'Plugin storage cache enabled'
      );
    }
  }

  /**
   * 写回回调函数，由LRUCache调用
   */
  private async writeBackToDb(
    key: string,
    value: any,
    ttl?: number
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const serializedValue = JSON.stringify(value);

    // Database-owned queries are finalized on close; uncached prepare() statements
    // otherwise retain the connection (and Windows file locks) until garbage collection.
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(this.pluginName, key, serializedValue, ttl ?? null, now * 1000);
  }

  /**
   * 获取值
   */
  async get<T = any>(key: string): Promise<T | null> {
    try {
      // 如果有缓存，先从缓存读取
      if (this.cache) {
        const cached = this.cache.get(key);
        if (cached !== null) {
          return cached as T;
        }
      }

      // 缓存未命中，从数据库读取
      const now = Math.floor(Date.now() / 1000);

      const query = this.db.query(`
        SELECT value, ttl FROM plugin_storage
        WHERE plugin_name = ? AND key = ?
      `);

      const result = query.get(this.pluginName, key) as { value: string; ttl: number | null } | null;

      if (!result) {
        return null;
      }

      // 检查 TTL
      if (result.ttl !== null && result.ttl < now) {
        // 已过期，惰性删除
        this.delete(key).catch(err => {
          logger.error({ error: err, pluginName: this.pluginName, key }, 'Failed to delete expired key');
        });
        return null;
      }

      const value = JSON.parse(result.value);

      // 将数据加载到缓存：clean hydration，读取本身不得标记 dirty 或触发写回。
      if (this.cache) {
        const ttlSeconds = result.ttl !== null ? result.ttl - now : undefined;
        this.cache.hydrate(key, value, ttlSeconds && ttlSeconds > 0 ? ttlSeconds : undefined);
      }

      return value;
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName, key }, 'Failed to get value from storage');
      return null;
    }
  }

  /**
   * 严格只读获取值：直接查询当前命名空间的已提交数据。
   * 不读取/回填/刷新 LRU 缓存，不清除过期记录；SQL 或 JSON 错误直接抛出。
   * 有效 JSON null 视为 found:true，缺失或已过期视为 found:false。
   */
  async readStrict<T = unknown>(key: string): Promise<PluginStorageReadResult<T>> {
    const now = Math.floor(Date.now() / 1000);

    const query = this.db.query(`
      SELECT value, ttl FROM plugin_storage
      WHERE plugin_name = ? AND key = ?
    `);

    const result = query.get(this.pluginName, key) as { value: string; ttl: number | null } | null;

    if (!result) {
      return { found: false };
    }

    // 保留既有 TTL 边界：ttl 恰好等于当前秒视为未过期。
    if (result.ttl !== null && result.ttl < now) {
      return { found: false };
    }

    const value = JSON.parse(result.value) as T;
    return { found: true, value };
  }

  /**
   * 设置值
   */
  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    try {
      // 如果有缓存，写入缓存（Write-Behind）
      if (this.cache) {
        this.cache.set(key, value, ttlSeconds);
        return; // 缓存会异步写回数据库
      }

      // 无缓存时，直接写入数据库
      const now = Math.floor(Date.now() / 1000);
      const ttl = ttlSeconds ? now + ttlSeconds : null;
      const serializedValue = JSON.stringify(value);

      const stmt = this.db.query(`
        INSERT OR REPLACE INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run(this.pluginName, key, serializedValue, ttl, now * 1000);
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName, key }, 'Failed to set value in storage');
      throw error;
    }
  }

  /**
   * 删除值
   */
  async delete(key: string): Promise<void> {
    try {
      // 从缓存中删除
      if (this.cache) {
        this.cache.remove(key);
      }

      // 从数据库中删除
      const stmt = this.db.query(`
        DELETE FROM plugin_storage
        WHERE plugin_name = ? AND key = ?
      `);

      stmt.run(this.pluginName, key);
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName, key }, 'Failed to delete value from storage');
      throw error;
    }
  }

  /**
   * 获取所有键
   */
  async keys(prefix?: string): Promise<string[]> {
    try {
      const now = Math.floor(Date.now() / 1000);
      let sql = `
        SELECT key FROM plugin_storage
        WHERE plugin_name = ?
        AND (ttl IS NULL OR ttl >= ?)
      `;
      const params: any[] = [this.pluginName, now];

      if (prefix) {
        sql += ` AND key LIKE ?`;
        params.push(`${prefix}%`);
      }

      const query = this.db.query(sql);
      const results = query.all(...params) as { key: string }[];

      return results.map(r => r.key);
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName }, 'Failed to list keys');
      return [];
    }
  }

  /**
   * 清空存储
   */
  async clear(): Promise<void> {
    try {
      // 先清空缓存
      if (this.cache) {
        await this.cache.clear();
      }

      // 清空数据库
      const stmt = this.db.query(`
        DELETE FROM plugin_storage
        WHERE plugin_name = ?
      `);

      stmt.run(this.pluginName);
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName }, 'Failed to clear storage');
      throw error;
    }
  }

  /**
   * 刷新缓存到数据库
   * 强制将所有dirty数据写回
   */
  async flush(): Promise<void> {
    if (this.cache) {
      await this.cache.flush();
    }
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats() {
    if (!this.cache) {
      return null;
    }
    return this.cache.getStats();
  }

  /**
   * 重置缓存统计信息
   */
  resetCacheStats(): void {
    if (this.cache) {
      this.cache.resetStats();
    }
  }

  /**
   * 原子递增操作
   * 使用 SQLite 的 json_set 函数实现原子操作
   */
  async increment(key: string, field: string, delta: number = 1): Promise<number> {
    try {
      validateJsonField(field);
      const now = Math.floor(Date.now() / 1000);
      const path = `$.${field}`;

      // 使用 UPSERT + json_set 实现原子递增
      const stmt = this.db.query(`
        INSERT INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
        VALUES (
          ?,
          ?,
          json_object(?, ?),
          NULL,
          ?
        )
        ON CONFLICT(plugin_name, key) DO UPDATE SET
          value = json_set(
            value,
            ?,
            COALESCE(json_extract(value, ?), 0) + ?
          ),
          updated_at = excluded.updated_at
        RETURNING json_extract(value, ?) as result
      `);

      const result = stmt.get(
        this.pluginName,
        key,
        field,
        delta,
        now * 1000,
        path,
        path,
        delta,
        path
      ) as { result: number } | null;

      return result?.result ?? delta;
    } catch (error) {
      logger.error(
        { error, pluginName: this.pluginName, key, field, delta },
        'Failed to increment value'
      );
      throw error;
    }
  }

  /**
   * 比较并交换操作
   * 仅当当前值等于期望值时，才更新为新值
   */
  async compareAndSet(
    key: string,
    field: string,
    expected: any,
    newValue: any
  ): Promise<boolean> {
    try {
      validateJsonField(field);
      const now = Math.floor(Date.now() / 1000);
      const path = `$.${field}`;
      const expectedJson = JSON.stringify(expected);
      const newValueJson = JSON.stringify(newValue);

      // 查询当前值
      const getCurrentStmt = this.db.query(`
        SELECT json_extract(value, ?) as currentValue
        FROM plugin_storage
        WHERE plugin_name = ? AND key = ?
      `);

      const current = getCurrentStmt.get(path, this.pluginName, key) as
        | { currentValue: any }
        | null;

      // 如果记录不存在，且期望值为null，则插入新记录
      if (!current && expected === null) {
        const insertStmt = this.db.query(`
          INSERT INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
          VALUES (?, ?, json_object(?, json(?)), NULL, ?)
        `);
        insertStmt.run(this.pluginName, key, field, newValueJson, now * 1000);
        return true;
      }

      // 如果记录不存在，但期望值不为null，则CAS失败
      if (!current && expected !== null) {
        return false;
      }

      // 记录存在，比较当前值
      const currentValueJson = JSON.stringify(current!.currentValue);
      if (currentValueJson !== expectedJson) {
        return false;
      }

      // CAS成功，更新值
      const updateStmt = this.db.query(`
        UPDATE plugin_storage
        SET value = json_set(value, ?, json(?)),
            updated_at = ?
        WHERE plugin_name = ? AND key = ?
        AND json_extract(value, ?) = json_extract(?, '$')
      `);

      const result = updateStmt.run(
        path,
        newValueJson,
        now * 1000,
        this.pluginName,
        key,
        path,
        expectedJson
      );

      return result.changes > 0;
    } catch (error) {
      logger.error(
        { error, pluginName: this.pluginName, key, field },
        'Failed to compare and set value'
      );
      throw error;
    }
  }
}

function validateJsonField(field: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
    throw new Error('invalid plugin storage JSON field');
  }
}

export class PluginStorageRevokedError extends Error {
  readonly name = 'PluginStorageRevokedError';
  constructor() { super('plugin storage capability is revoked'); }
}

export type PluginStorageCapability = {
  readonly storage: PluginStorage;
  readonly revoke: () => void;
};

/** Returns a storage capability whose database and namespace remain in the closure. */
export function createPluginStorageCapability(db: Database, pluginName: string, cacheOptions?: LRUCacheOptions): PluginStorageCapability {
  const implementation = new SQLitePluginStorage(db, pluginName, cacheOptions);
  const immediate = cacheOptions ? new SQLitePluginStorage(db, pluginName) : implementation;
  let revoked = false;
  const assertActive = (): void => {
    if (revoked) throw new PluginStorageRevokedError();
  };
  const wrap = (implementation: SQLitePluginStorage) => Object.freeze({
    ...(implementation.observation ? { observation: Object.freeze({
      withDatabase: <T>(operation: (database: Database) => T): T => {
        assertActive();
        return implementation.observation!.withDatabase(operation);
      },
    }) } : {}),
    uncached: (): PluginStorage => { assertActive(); return uncached; },
    flush: async (): Promise<void> => { assertActive(); await implementation.flush(); },
    get: async <T = any>(key: string): Promise<T | null> => {
      assertActive();
      return implementation.get<T>(key);
    },
    readStrict: async <T = unknown>(key: string): Promise<PluginStorageReadResult<T>> => {
      assertActive();
      return implementation.readStrict<T>(key);
    },
    set: async (key: string, value: any, ttlSeconds?: number): Promise<void> => {
      assertActive();
      return implementation.set(key, value, ttlSeconds);
    },
    delete: async (key: string): Promise<void> => {
      assertActive();
      return implementation.delete(key);
    },
    keys: async (prefix?: string): Promise<string[]> => {
      assertActive();
      return implementation.keys(prefix);
    },
    clear: async (): Promise<void> => {
      assertActive();
      return implementation.clear();
    },
    increment: async (key: string, field: string, delta?: number): Promise<number> => {
      assertActive();
      return implementation.increment(key, field, delta);
    },
    compareAndSet: async (key: string, field: string, expected: any, newValue: any): Promise<boolean> => {
      assertActive();
      return implementation.compareAndSet(key, field, expected, newValue);
    },
  }) satisfies PluginStorage;
  const uncached = wrap(immediate);
  const storage = cacheOptions ? wrap(implementation) : uncached;
  return { storage, revoke: () => {
    if (revoked) return;
    revoked = true;
    // Complete previously accepted writes and cancel their write-behind timer.
    void implementation.flush();
  } };
}

/** Observation capabilities must never expose the configuration/credential database. */
function isObservationDatabase(db: Database): boolean {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'configuration_state'").get()) {
    return false;
  }
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plugin_storage'").get()) {
    return false;
  }
  return true;
}
