import type {
  StatsSnapshot,
  TimeSlotData,
  AggregatedDataPoint,
  TimeRange,
  StatsHistoryV2
} from '../types';
import { TIME_RANGES, STORAGE_CONFIG } from '../constants';
import { fileStorageManager } from '../utils/file-storage';
import { batchWriter } from '../utils/batch-writer';
import { fileCache } from '../utils/file-cache';

interface CumulativeStats {
  requests: number;
  errors: number;
  responseTimes: number[];
  startTime: number;
}

export class PersistentStatsCollector {
  // 内存中只保留当前活跃时间槽
  private currentStats = new Map<string, TimeSlotData>();

  // 已完成但尚未写入文件的槽（等待批量写入）
  private pendingWrites = new Map<string, TimeSlotData>();

  // 保留兼容性的累计统计（用于实时快照）
  private requests = 0;
  private errors = 0;
  private responseTimes: number[] = [];
  private startTime = Date.now();

  // 累计统计的持久化文件路径
  private readonly CUMULATIVE_STATS_FILE = `${STORAGE_CONFIG.dataDir}/cumulative.json`.replace(/\/\//g, '/');
  private lastCumulativeSave = Date.now();
  private readonly CUMULATIVE_SAVE_INTERVAL = 60 * 1000; // 每分钟保存一次

  constructor() {
    this.loadCumulativeStats();
  }

  // 从文件加载累计统计数据
  private async loadCumulativeStats() {
    try {
      const file = Bun.file(this.CUMULATIVE_STATS_FILE);
      if (await file.exists()) {
        const content = await file.text();
        const stats: CumulativeStats = JSON.parse(content);

        this.requests = stats.requests || 0;
        this.errors = stats.errors || 0;
        this.responseTimes = stats.responseTimes || [];
        this.startTime = stats.startTime || Date.now();

        console.log(`Loaded cumulative stats: ${this.requests} requests, ${this.errors} errors`);
      }
    } catch (error) {
      console.error('Failed to load cumulative stats:', error);
      // 如果加载失败，使用默认值（已在构造函数中初始化）
    }
  }

  // 保存累计统计数据到文件
  private async saveCumulativeStats() {
    try {
      const stats: CumulativeStats = {
        requests: this.requests,
        errors: this.errors,
        responseTimes: this.responseTimes,
        startTime: this.startTime
      };

      await Bun.write(this.CUMULATIVE_STATS_FILE, JSON.stringify(stats));
      this.lastCumulativeSave = Date.now();
    } catch (error) {
      console.error('Failed to save cumulative stats:', error);
    }
  }

  recordRequest(success: boolean, responseTime: number) {
    const now = new Date();

    // 更新累计统计（兼容性）
    this.requests++;
    if (!success) this.errors++;
    this.responseTimes.push(responseTime);

    // 保留最近1000个响应时间用于实时快照
    if (this.responseTimes.length > 1000) {
      this.responseTimes.shift();
    }

    // 更新内存中的当前时间槽
    this.updateCurrentSlots(now, success, responseTime);

    // 检查并持久化完整的时间槽
    this.checkAndPersistCompletedSlots(now);

    // 定期保存累计统计
    if (Date.now() - this.lastCumulativeSave >= this.CUMULATIVE_SAVE_INTERVAL) {
      this.saveCumulativeStats();
    }
  }

  private updateCurrentSlots(timestamp: Date, success: boolean, responseTime: number) {
    // 更新1分钟槽
    this.updateTimeSlot(timestamp, 'minute', success, responseTime);
    // 更新30分钟槽
    this.updateTimeSlot(timestamp, 'halfHour', success, responseTime);
    // 更新1小时槽
    this.updateTimeSlot(timestamp, 'hour', success, responseTime);
  }

  private updateTimeSlot(
    timestamp: Date,
    slotType: 'minute' | 'halfHour' | 'hour',
    success: boolean,
    responseTime: number
  ) {
    const slotStart = this.getSlotStart(timestamp, slotType);
    const slotKey = `${slotType}_${slotStart}`;

    // 获取或创建时间槽
    let slot = this.currentStats.get(slotKey);
    if (!slot) {
      slot = {
        slotStart,
        requests: 0,
        errors: 0,
        responseTimes: [],
        maxResponseTimes: STORAGE_CONFIG.maxResponseTimeSamples
      };
      this.currentStats.set(slotKey, slot);
    }

    // 更新统计数据
    slot.requests++;
    if (!success) slot.errors++;

    // 响应时间采样（避免内存无限增长）
    if (slot.responseTimes.length < slot.maxResponseTimes) {
      slot.responseTimes.push(responseTime);
    } else {
      // 随机替换策略，保持样本代表性
      const randomIndex = Math.floor(Math.random() * slot.maxResponseTimes);
      slot.responseTimes[randomIndex] = responseTime;
    }
  }

  private getSlotStart(timestamp: Date, slotType: 'minute' | 'halfHour' | 'hour'): number {
    const time = new Date(timestamp);

    switch (slotType) {
      case 'minute':
        // 对齐到分钟边界
        time.setSeconds(0, 0);
        return time.getTime();

      case 'halfHour':
        // 对齐到30分钟边界
        time.setSeconds(0, 0);
        const minutes = time.getMinutes();
        time.setMinutes(Math.floor(minutes / 30) * 30);
        return time.getTime();

      case 'hour':
        // 对齐到小时边界
        time.setMinutes(0, 0, 0);
        return time.getTime();

      default:
        throw new Error(`Unknown slot type: ${slotType}`);
    }
  }

  private async checkAndPersistCompletedSlots(currentTime: Date) {
    const completedSlots: string[] = [];

    for (const [slotKey, slot] of this.currentStats.entries()) {
      if (this.isSlotCompleted(slot, currentTime, slotKey)) {
        // 使用批量写入器，提高性能
        batchWriter.scheduleWrite(slotKey, slot);
        // 移动到待写入队列，保留在内存中供查询使用
        this.pendingWrites.set(slotKey, slot);
        completedSlots.push(slotKey);
      }
    }

    // 从活跃槽中移除（但保留在pendingWrites中）
    completedSlots.forEach(key => this.currentStats.delete(key));

    // 清理超过1小时的待写入槽（此时应该已经写入文件了）
    this.cleanupOldPendingWrites();
  }

  private cleanupOldPendingWrites() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const toDelete: string[] = [];

    for (const [slotKey, slot] of this.pendingWrites.entries()) {
      if (slot.slotStart < oneHourAgo) {
        toDelete.push(slotKey);
      }
    }

    toDelete.forEach(key => this.pendingWrites.delete(key));
  }

  private isSlotCompleted(slot: TimeSlotData, currentTime: Date, slotKey: string): boolean {
    const slotType = slotKey.split('_')[0] as 'minute' | 'halfHour' | 'hour';
    const slotStart = slot.slotStart;
    const currentSlotStart = this.getSlotStart(currentTime, slotType);

    // 如果当前时间已经过了这个槽的时间范围，则认为槽已完成
    return currentSlotStart > slotStart;
  }

  // 保留兼容性方法
  getSnapshot(): StatsSnapshot {
    const now = Date.now();
    const uptime = (now - this.startTime) / 1000;
    const qps = uptime > 0 ? this.requests / uptime : 0;
    const successRate = this.requests > 0
      ? ((this.requests - this.errors) / this.requests) * 100
      : 100;
    const avgResponseTime = this.responseTimes.length > 0
      ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
      : 0;

    return {
      totalRequests: this.requests,
      requestsPerSecond: parseFloat(qps.toFixed(2)),
      successRate: parseFloat(successRate.toFixed(2)),
      averageResponseTime: parseFloat(avgResponseTime.toFixed(2)),
      timestamp: new Date().toISOString()
    };
  }

  async getHistoryData(range: TimeRange): Promise<AggregatedDataPoint[]> {
    const timePoints = this.generateContinuousTimePoints(range);
    const results: AggregatedDataPoint[] = [];

    for (const timePoint of timePoints) {
      // 确定该时间点对应的槽类型
      const slotType = this.getSlotTypeForRange(range);
      const slotStart = this.getSlotStart(timePoint, slotType);
      const slotKey = `${slotType}_${slotStart}`;

      // 先检查活跃槽
      let slotData = this.currentStats.get(slotKey);

      // 再检查待写入队列
      if (!slotData) {
        slotData = this.pendingWrites.get(slotKey);
      }

      // 最后从缓存或文件加载
      if (!slotData) {
        slotData = await fileCache.get(slotKey);
      }

      // 转换为聚合数据点
      const aggregatedPoint = this.convertToAggregatedPoint(slotData, timePoint);
      results.push(aggregatedPoint);
    }

    return results;
  }

  private generateContinuousTimePoints(range: TimeRange): Date[] {
    const config = TIME_RANGES[range];
    const endTime = new Date();
    const points: Date[] = [];

    for (let i = config.maxPoints - 1; i >= 0; i--) {
      const time = new Date(endTime.getTime() - i * config.interval);
      // 对齐到时间槽边界
      const alignedTime = this.alignToSlotBoundary(time, range);
      points.push(alignedTime);
    }

    return points;
  }

  private alignToSlotBoundary(time: Date, range: TimeRange): Date {
    const slotType = this.getSlotTypeForRange(range);
    const slotStart = this.getSlotStart(time, slotType);
    return new Date(slotStart);
  }

  private getSlotTypeForRange(range: TimeRange): 'minute' | 'halfHour' | 'hour' {
    switch (range) {
      case '1h':
        return 'minute';
      case '12h':
        return 'halfHour';
      case '24h':
        return 'hour';
      default:
        throw new Error(`Unknown range: ${range}`);
    }
  }

  private convertToAggregatedPoint(
    slot: TimeSlotData | null,
    timePoint: Date
  ): AggregatedDataPoint {
    if (!slot) {
      return {
        timestamp: timePoint.toISOString(),
        requests: 0,
        errors: 0,
        avgResponseTime: 0,
        successRate: 100  // 无请求时成功率为100%
      };
    }

    const avgResponseTime = slot.responseTimes.length > 0
      ? slot.responseTimes.reduce((sum, time) => sum + time, 0) / slot.responseTimes.length
      : 0;

    const successRate = slot.requests > 0
      ? ((slot.requests - slot.errors) / slot.requests) * 100
      : 100;  // 无请求时成功率为100%

    return {
      timestamp: timePoint.toISOString(),
      requests: slot.requests,
      errors: slot.errors,
      avgResponseTime: Math.round(avgResponseTime),
      successRate: Math.round(successRate * 100) / 100
    };
  }

  reset() {
    this.requests = 0;
    this.errors = 0;
    this.responseTimes = [];
    this.currentStats.clear();
    this.pendingWrites.clear();
    this.startTime = Date.now();

    // 重置后也保存，避免下次启动时加载旧数据
    this.saveCumulativeStats();
  }

  // 强制刷新所有待写入的数据（应用关闭时调用）
  async flush() {
    await batchWriter.forceFlush();
    // 同时保存累计统计
    await this.saveCumulativeStats();
  }
}

export const persistentStatsCollector = new PersistentStatsCollector();