import { Database } from 'bun:sqlite';
import type { PluginStorage } from './plugin.types';
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

  constructor(
    db: Database,
    pluginName: string,
    cacheOptions?: LRUCacheOptions
  ) {
    this.db = db;
    this.pluginName = pluginName;

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

    const stmt = this.db.prepare(`
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

      const query = this.db.prepare(`
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

      // 将数据加载到缓存
      if (this.cache && result.ttl) {
        const ttlSeconds = result.ttl - now;
        this.cache.set(key, value, ttlSeconds > 0 ? ttlSeconds : undefined);
      } else if (this.cache) {
        this.cache.set(key, value);
      }

      return value;
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName, key }, 'Failed to get value from storage');
      return null;
    }
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

      const stmt = this.db.prepare(`
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
      const stmt = this.db.prepare(`
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

      const query = this.db.prepare(sql);
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
      const stmt = this.db.prepare(`
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
      const stmt = this.db.prepare(`
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
      const getCurrentStmt = this.db.prepare(`
        SELECT json_extract(value, ?) as currentValue
        FROM plugin_storage
        WHERE plugin_name = ? AND key = ?
      `);

      const current = getCurrentStmt.get(path, this.pluginName, key) as
        | { currentValue: any }
        | null;

      // 如果记录不存在，且期望值为null，则插入新记录
      if (!current && expected === null) {
        const insertStmt = this.db.prepare(`
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
      const updateStmt = this.db.prepare(`
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
export function createPluginStorageCapability(db: Database, pluginName: string): PluginStorageCapability {
  const implementation = new SQLitePluginStorage(db, pluginName);
  let revoked = false;
  const assertActive = (): void => {
    if (revoked) throw new PluginStorageRevokedError();
  };
  const storage = Object.freeze({
    get: async <T = any>(key: string): Promise<T | null> => {
      assertActive();
      return implementation.get<T>(key);
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
  return { storage, revoke: () => { revoked = true; } };
}
