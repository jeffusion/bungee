import type { TimeSlotData } from '../types';
import { fileStorageManager } from './file-storage';

interface CacheEntry {
  data: TimeSlotData;
  timestamp: number;
}

export class FileCache {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存
  private readonly MAX_CACHE_SIZE = 1000; // 最大缓存条目数

  async get(slotKey: string): Promise<TimeSlotData | null> {
    // 先检查缓存
    const cached = this.cache.get(slotKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    // 从文件加载
    const data = await fileStorageManager.readSlot(slotKey);
    if (data) {
      this.set(slotKey, data);
    }

    return data;
  }

  set(slotKey: string, data: TimeSlotData) {
    // 如果缓存已满，清理最旧的条目
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      this.evictOldest();
    }

    this.cache.set(slotKey, {
      data,
      timestamp: Date.now()
    });
  }

  private evictOldest() {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  // 清理过期缓存
  cleanup() {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp >= this.CACHE_TTL) {
        expiredKeys.push(key);
      }
    }

    expiredKeys.forEach(key => this.cache.delete(key));

    if (expiredKeys.length > 0) {
      console.log(`Cleaned up ${expiredKeys.length} expired cache entries`);
    }
  }

  // 获取缓存统计信息
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.MAX_CACHE_SIZE,
      ttl: this.CACHE_TTL
    };
  }
}

export const fileCache = new FileCache();

// 定期清理过期缓存
setInterval(() => {
  fileCache.cleanup();
}, 60 * 1000); // 每分钟清理一次