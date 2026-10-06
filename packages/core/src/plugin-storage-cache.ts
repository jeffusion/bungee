import { logger } from './logger';

/**
 * LRU缓存节点
 */
interface CacheNode<T> {
  key: string;
  value: T;
  prev: CacheNode<T> | null;
  next: CacheNode<T> | null;
  dirty: boolean; // 标记是否需要写回
  ttl?: number; // 过期时间戳（秒）
}

/**
 * LRU缓存配置
 */
export interface LRUCacheOptions {
  /**
   * 最大缓存条目数
   */
  maxSize: number;

  /**
   * Write-Behind延迟（毫秒）
   * 默认1000ms（1秒）
   */
  writeDelay?: number;

  /**
   * 写回批次大小
   * 默认10
   */
  writeBatchSize?: number;
}

/**
 * LRU缓存实现
 * 支持：
 * - LRU淘汰策略
 * - Write-Behind写入策略
 * - TTL过期检查
 */
export class LRUCache<T = any> {
  private cache: Map<string, CacheNode<T>> = new Map();
  private head: CacheNode<T> | null = null;
  private tail: CacheNode<T> | null = null;
  private maxSize: number;
  private writeDelay: number;
  private writeBatchSize: number;

  // Write-Behind队列
  private dirtyKeys: Set<string> = new Set();
  private writeTimer: Timer | null = null;

  // 写回回调函数
  private writeBackFn: (key: string, value: T, ttl?: number) => Promise<void>;

  // 统计信息
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    writes: 0,
  };

  constructor(
    options: LRUCacheOptions,
    writeBackFn: (key: string, value: T, ttl?: number) => Promise<void>
  ) {
    this.maxSize = options.maxSize;
    this.writeDelay = options.writeDelay ?? 1000;
    this.writeBatchSize = options.writeBatchSize ?? 10;
    this.writeBackFn = writeBackFn;
  }

  /**
   * 获取缓存值
   */
  get(key: string): T | null {
    const node = this.cache.get(key);

    if (!node) {
      this.stats.misses++;
      return null;
    }

    // 检查TTL
    const now = Math.floor(Date.now() / 1000);
    if (node.ttl && node.ttl < now) {
      // 已过期，移除
      this.remove(key);
      this.stats.misses++;
      return null;
    }

    // 移动到链表头部（最近使用）
    this.moveToHead(node);
    this.stats.hits++;
    return node.value;
  }

  /**
   * 设置缓存值
   */
  set(key: string, value: T, ttlSeconds?: number): void {
    const existingNode = this.cache.get(key);

    if (existingNode) {
      // 更新现有节点
      existingNode.value = value;
      existingNode.dirty = true;
      existingNode.ttl = ttlSeconds
        ? Math.floor(Date.now() / 1000) + ttlSeconds
        : undefined;
      this.moveToHead(existingNode);
    } else {
      // 创建新节点
      const newNode: CacheNode<T> = {
        key,
        value,
        prev: null,
        next: null,
        dirty: true,
        ttl: ttlSeconds
          ? Math.floor(Date.now() / 1000) + ttlSeconds
          : undefined,
      };

      this.cache.set(key, newNode);
      this.addToHead(newNode);

      // 检查是否超过容量
      if (this.cache.size > this.maxSize) {
        const removed = this.removeTail();
        if (removed) {
          this.cache.delete(removed.key);
          this.stats.evictions++;

          // 如果被淘汰的节点是dirty，立即写回
          if (removed.dirty) {
            this.writeBackImmediately(removed.key, removed.value, removed.ttl);
          }
        }
      }
    }

    // 标记为dirty并触发Write-Behind
    this.dirtyKeys.add(key);
    this.scheduleWriteBack();
  }

  /**
   * 从数据库加载已提交值到缓存（clean hydration）。
   * 不标记 dirty、不调度写回：读取本身不得覆写其它 writer 的新值。
   * 若该 key 已有尚未写回的本地 dirty 写，则保留本地值，不被数据库旧值覆盖。
   */
  hydrate(key: string, value: T, ttlSeconds?: number): void {
    const ttl = ttlSeconds
      ? Math.floor(Date.now() / 1000) + ttlSeconds
      : undefined;
    const existingNode = this.cache.get(key);

    if (existingNode) {
      if (existingNode.dirty) return; // 保留尚未写回的本地写
      existingNode.value = value;
      existingNode.ttl = ttl;
      this.moveToHead(existingNode);
      return;
    }

    const newNode: CacheNode<T> = {
      key,
      value,
      prev: null,
      next: null,
      dirty: false,
      ttl,
    };

    this.cache.set(key, newNode);
    this.addToHead(newNode);

    if (this.cache.size > this.maxSize) {
      const removed = this.removeTail();
      if (removed) {
        this.cache.delete(removed.key);
        this.stats.evictions++;

        // 清洁加载的节点被淘汰时无需写回；脏节点沿用既有立即写回语义。
        if (removed.dirty) {
          this.writeBackImmediately(removed.key, removed.value, removed.ttl);
        }
      }
    }
  }

  /**
   * 删除缓存值
   */
  remove(key: string): void {
    const node = this.cache.get(key);
    if (!node) return;

    this.removeNode(node);
    this.cache.delete(key);
    this.dirtyKeys.delete(key);
  }

  /**
   * 清空缓存
   */
  async clear(): Promise<void> {
    // 先刷新所有dirty数据
    await this.flush();

    this.cache.clear();
    this.dirtyKeys.clear();
    this.head = null;
    this.tail = null;
  }

  /**
   * 刷新所有dirty数据到存储
   */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    const dirtyKeysArray = Array.from(this.dirtyKeys);
    await this.writeBatch(dirtyKeysArray);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0,
    };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      writes: 0,
    };
  }

  // ===== 私有方法 =====

  private moveToHead(node: CacheNode<T>): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  private addToHead(node: CacheNode<T>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }

    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  private removeNode(node: CacheNode<T>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
  }

  private removeTail(): CacheNode<T> | null {
    if (!this.tail) return null;

    const removed = this.tail;
    this.removeNode(removed);
    return removed;
  }

  private scheduleWriteBack(): void {
    if (this.writeTimer) return;

    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.performWriteBack().catch((err) => {
        logger.error({ error: err }, 'Failed to perform write-back');
      });
    }, this.writeDelay);
  }

  private async performWriteBack(): Promise<void> {
    if (this.dirtyKeys.size === 0) return;

    // 取一批dirty keys进行写回
    const batch = Array.from(this.dirtyKeys).slice(0, this.writeBatchSize);
    await this.writeBatch(batch);

    // 如果还有更多dirty keys，继续调度
    if (this.dirtyKeys.size > 0) {
      this.scheduleWriteBack();
    }
  }

  private async writeBatch(keys: string[]): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const key of keys) {
      const node = this.cache.get(key);
      if (!node || !node.dirty) {
        this.dirtyKeys.delete(key);
        continue;
      }

      promises.push(
        this.writeBackFn(key, node.value, node.ttl).then(() => {
          node.dirty = false;
          this.dirtyKeys.delete(key);
          this.stats.writes++;
        })
      );
    }

    await Promise.allSettled(promises);
  }

  private async writeBackImmediately(
    key: string,
    value: T,
    ttl?: number
  ): Promise<void> {
    try {
      await this.writeBackFn(key, value, ttl);
      this.stats.writes++;
    } catch (error) {
      logger.error({ error, key }, 'Failed to write back evicted entry');
    }
  }
}
