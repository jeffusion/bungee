import { logger } from './logger';

/**
 * 对象池配置选项
 */
export interface PoolOptions {
  /**
   * 池中最小对象数（预热时创建）
   * @default 2
   */
  minSize?: number;

  /**
   * 池中最大对象数（防止无限增长）
   * @default 20
   */
  maxSize?: number;

  /**
   * 对象空闲超时时间（毫秒）
   * 超时后将被销毁以释放内存
   * @default undefined（不超时）
   */
  idleTimeout?: number;
}

/**
 * 池化对象的包装器
 */
interface PooledObject<T> {
  instance: T;
  inUse: boolean;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * 通用对象池
 *
 * 用于复用重量级对象（如 ML 模型、数据库连接等）以提升性能。
 *
 * 特性：
 * - 支持最小/最大池大小限制
 * - 自动调用对象的 reset() 方法进行状态清理
 * - 支持空闲超时自动销毁（可选）
 * - 线程安全的获取/归还机制
 *
 * @template T 池化对象类型，必须有 name 属性
 *
 * @example
 * ```ts
 * const pool = new PluginPool<MyPlugin>(
 *   () => new MyPlugin({ apiKey: 'xxx' }),
 *   { minSize: 2, maxSize: 10 }
 * );
 *
 * const plugin = await pool.acquire();
 * try {
 *   await plugin.doSomething();
 * } finally {
 *   await pool.release(plugin);
 * }
 * ```
 */
export class PluginPool<T extends { name: string; reset?(): void | Promise<void>; onDestroy?(): void | Promise<void> }> {
  private pool: PooledObject<T>[] = [];
  private factory: () => T;
  private options: Required<PoolOptions>;
  private destroyed: boolean = false;
  private idleCheckInterval?: Timer;

  /**
   * 创建对象池
   *
   * @param factory 对象工厂函数，用于创建新实例
   * @param options 池配置选项
   */
  constructor(factory: () => T, options: PoolOptions = {}) {
    this.factory = factory;
    this.options = {
      minSize: options.minSize ?? 2,
      maxSize: options.maxSize ?? 20,
      idleTimeout: options.idleTimeout ?? 0
    };

    // 验证配置
    if (this.options.minSize < 0 || this.options.maxSize < 1) {
      throw new Error('Invalid pool size: minSize >= 0 and maxSize >= 1');
    }
    if (this.options.minSize > this.options.maxSize) {
      throw new Error('Invalid pool size: minSize must be <= maxSize');
    }

    // 预热：创建最小数量的对象
    for (let i = 0; i < this.options.minSize; i++) {
      try {
        const instance = this.factory();
        this.pool.push({
          instance,
          inUse: false,
          createdAt: Date.now(),
          lastUsedAt: Date.now()
        });
      } catch (error) {
        logger.error({ error, index: i }, 'Failed to create instance during pool initialization');
      }
    }

    logger.debug(
      {
        poolSize: this.pool.length,
        minSize: this.options.minSize,
        maxSize: this.options.maxSize
      },
      'Plugin pool initialized'
    );

    // 如果启用了空闲超时，启动定期检查
    if (this.options.idleTimeout > 0) {
      this.startIdleCheck();
    }
  }

  /**
   * 从池中获取一个对象实例
   *
   * 获取策略：
   * 1. 如果有空闲对象，直接返回
   * 2. 如果池未达到最大值，创建新对象
   * 3. 否则抛出错误（池耗尽）
   *
   * @returns Promise<T> 对象实例
   * @throws Error 如果池已销毁或池耗尽
   */
  async acquire(): Promise<T> {
    if (this.destroyed) {
      throw new Error('Cannot acquire from destroyed pool');
    }

    // 1. 查找空闲对象
    const available = this.pool.find(obj => !obj.inUse);

    if (available) {
      available.inUse = true;
      available.lastUsedAt = Date.now();

      logger.debug(
        {
          instanceName: available.instance.name,
          poolSize: this.pool.length,
          inUse: this.pool.filter(o => o.inUse).length
        },
        'Acquired instance from pool'
      );

      return available.instance;
    }

    // 2. 如果池未满，创建新对象
    if (this.pool.length < this.options.maxSize) {
      try {
        const instance = this.factory();
        const pooledObject: PooledObject<T> = {
          instance,
          inUse: true,
          createdAt: Date.now(),
          lastUsedAt: Date.now()
        };

        this.pool.push(pooledObject);

        logger.debug(
          {
            instanceName: instance.name,
            poolSize: this.pool.length,
            inUse: this.pool.filter(o => o.inUse).length
          },
          'Created new instance for pool'
        );

        return instance;
      } catch (error) {
        logger.error({ error }, 'Failed to create new instance');
        throw error;
      }
    }

    // 3. 池已满
    throw new Error(
      `Plugin pool exhausted: all ${this.options.maxSize} instances are in use`
    );
  }

  /**
   * 归还对象到池中
   *
   * 归还时会自动调用对象的 reset() 方法（如果存在）来清理状态
   *
   * @param instance 要归还的对象实例
   * @throws Error 如果对象不属于此池或已被归还
   */
  async release(instance: T): Promise<void> {
    if (this.destroyed) {
      logger.warn('Attempted to release instance to destroyed pool');
      return;
    }

    const pooledObject = this.pool.find(obj => obj.instance === instance);

    if (!pooledObject) {
      throw new Error('Instance does not belong to this pool');
    }

    if (!pooledObject.inUse) {
      throw new Error('Instance has already been released');
    }

    // 调用 reset 方法清理状态
    if (instance.reset) {
      try {
        await instance.reset();
      } catch (error) {
        logger.error(
          { error, instanceName: instance.name },
          'Error during instance reset, removing from pool'
        );

        // 重置失败，从池中移除此对象
        const index = this.pool.indexOf(pooledObject);
        if (index > -1) {
          this.pool.splice(index, 1);
        }

        // 尝试销毁对象
        try {
          if (instance.onDestroy) {
            await instance.onDestroy();
          }
        } catch (destroyError) {
          logger.error(
            { error: destroyError, instanceName: instance.name },
            'Error during instance destroy'
          );
        }

        return;
      }
    }

    // 标记为可用
    pooledObject.inUse = false;
    pooledObject.lastUsedAt = Date.now();

    logger.debug(
      {
        instanceName: instance.name,
        poolSize: this.pool.length,
        available: this.pool.filter(o => !o.inUse).length
      },
      'Released instance back to pool'
    );
  }

  /**
   * 获取池的统计信息
   */
  getStats() {
    const now = Date.now();
    return {
      total: this.pool.length,
      available: this.pool.filter(o => !o.inUse).length,
      inUse: this.pool.filter(o => o.inUse).length,
      minSize: this.options.minSize,
      maxSize: this.options.maxSize,
      objects: this.pool.map(obj => ({
        name: obj.instance.name,
        inUse: obj.inUse,
        ageMs: now - obj.createdAt,
        idleMs: now - obj.lastUsedAt
      }))
    };
  }

  /**
   * 销毁对象池
   *
   * 调用所有对象的 onDestroy() 方法并清空池
   */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    // 停止空闲检查
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = undefined;
    }

    // 销毁所有对象
    for (const pooledObject of this.pool) {
      try {
        if (pooledObject.instance.onDestroy) {
          await pooledObject.instance.onDestroy();
        }
      } catch (error) {
        logger.error(
          { error, instanceName: pooledObject.instance.name },
          'Error during pool destruction'
        );
      }
    }

    this.pool = [];

    logger.info('Plugin pool destroyed');
  }

  /**
   * 启动空闲对象检查
   * 定期清理超时的空闲对象
   */
  private startIdleCheck(): void {
    const checkInterval = Math.min(this.options.idleTimeout / 2, 60000); // 最多每分钟检查一次

    this.idleCheckInterval = setInterval(async () => {
      const now = Date.now();
      const toRemove: PooledObject<T>[] = [];

      // 找出所有超时的空闲对象
      for (const obj of this.pool) {
        if (
          !obj.inUse &&
          this.pool.length > this.options.minSize &&
          now - obj.lastUsedAt > this.options.idleTimeout
        ) {
          toRemove.push(obj);
        }
      }

      // 移除并销毁超时对象
      for (const obj of toRemove) {
        const index = this.pool.indexOf(obj);
        if (index > -1) {
          this.pool.splice(index, 1);

          try {
            if (obj.instance.onDestroy) {
              await obj.instance.onDestroy();
            }
            logger.debug(
              { instanceName: obj.instance.name, idleMs: now - obj.lastUsedAt },
              'Removed idle instance from pool'
            );
          } catch (error) {
            logger.error(
              { error, instanceName: obj.instance.name },
              'Error destroying idle instance'
            );
          }
        }
      }
    }, checkInterval);
  }
}
