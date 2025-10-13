# Dashboard 监控图表重构方案

## 概述

本文档描述了 Dashboard 监控图表功能的重构方案，将现有的"10秒"、"1分钟"、"5分钟"时间范围调整为"1小时"、"12小时"、"24小时"，并采用轻量持久化存储方案确保内存安全和数据可靠性。

## 需求分析

### 当前问题
1. **时间范围不合理**: 10秒、1分钟、5分钟的监控范围过短，缺乏长期趋势分析
2. **数据处理简陋**: 简单的累加差值计算，缺乏真正的时间段聚合
3. **时间不连续**: 当某时间段无数据时，图表出现断点
4. **内存风险**: 原始设计可能导致内存泄漏和进程重启数据丢失

### 新需求
- **时间范围**: "1小时"、"12小时"、"24小时"
- **数据间隔**:
  - 1小时图表：1分钟间隔
  - 12小时图表：30分钟间隔
  - 24小时图表：1小时间隔
- **数据连续性**: 即使无数据的时间段也必须在图表中显示
- **内存安全**: 控制内存使用，避免泄漏风险

## 技术方案：轻量持久化存储

### 方案选择理由

经过对比分析，选择轻量持久化方案：

| 优势 | 说明 |
|------|------|
| **内存占用最小** | ~1KB，最大化保护代理服务性能 |
| **数据完整性最高** | 100%数据保留，服务重启零丢失 |
| **适合多进程架构** | worker进程可共享文件存储 |
| **系统资源友好** | GC压力最小，适合长期运行 |

### 核心架构

```typescript
class PersistentStatsCollector {
  // 内存中只保留当前活跃时间槽
  private currentStats = new Map<string, TimeSlotData>();

  // 文件存储配置
  private readonly STORAGE_CONFIG = {
    dataDir: './data/stats/',
    retentionHours: 24,
    fileFormat: 'json'
  };
}
```

## 详细设计

### 1. 时间间隔配置

```typescript
type TimeRange = '1h' | '12h' | '24h';

interface TimeRangeConfig {
  range: TimeRange;
  interval: number;    // 数据点间隔（毫秒）
  maxPoints: number;   // 最大数据点数
  displayName: string;
}

const TIME_RANGES: Record<TimeRange, TimeRangeConfig> = {
  '1h': {
    range: '1h',
    interval: 60 * 1000,      // 1分钟
    maxPoints: 60,             // 60个点
    displayName: '1小时'
  },
  '12h': {
    range: '12h',
    interval: 30 * 60 * 1000,  // 30分钟
    maxPoints: 24,             // 24个点
    displayName: '12小时'
  },
  '24h': {
    range: '24h',
    interval: 60 * 60 * 1000,  // 1小时
    maxPoints: 24,             // 24个点
    displayName: '24小时'
  }
};
```

### 2. 数据结构设计

```typescript
interface TimeSlotData {
  slotStart: number;          // 时间槽开始时间戳
  requests: number;           // 该槽内请求总数
  errors: number;             // 该槽内错误总数
  responseTimes: number[];    // 响应时间样本
  maxResponseTimes: number;   // 最大样本数（防止内存泄漏）
}

interface AggregatedDataPoint {
  timestamp: string;
  requests: number;        // 该时段内实际请求数
  errors: number;          // 该时段内实际错误数
  avgResponseTime: number; // 该时段内平均响应时间
  successRate: number;     // 该时段内成功率
}
```

### 3. 核心实现

#### 数据收集与持久化

```typescript
class PersistentStatsCollector {
  recordRequest(success: boolean, responseTime: number) {
    const now = new Date();

    // 更新内存中的当前时间槽
    this.updateCurrentSlots(now, success, responseTime);

    // 检查并持久化完整的时间槽
    this.checkAndPersistCompletedSlots(now);
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
        maxResponseTimes: 100 // 限制样本数量
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

  private async checkAndPersistCompletedSlots(currentTime: Date) {
    const completedSlots: string[] = [];

    for (const [slotKey, slot] of this.currentStats.entries()) {
      if (this.isSlotCompleted(slot, currentTime)) {
        await this.persistSlot(slot, slotKey);
        completedSlots.push(slotKey);
      }
    }

    // 清理已持久化的槽
    completedSlots.forEach(key => this.currentStats.delete(key));
  }

  private async persistSlot(slot: TimeSlotData, slotKey: string) {
    const filename = `${slotKey}.json`;
    const filepath = path.join(this.STORAGE_CONFIG.dataDir, filename);

    try {
      await Bun.write(filepath, JSON.stringify(slot));
      console.log(`Persisted slot: ${filename}`);
    } catch (error) {
      console.error(`Failed to persist slot: ${filename}`, error);
    }
  }
}
```

#### 历史数据查询

```typescript
async getHistoryData(range: TimeRange): Promise<AggregatedDataPoint[]> {
  const timePoints = this.generateContinuousTimePoints(range);
  const config = TIME_RANGES[range];

  const results: AggregatedDataPoint[] = [];

  for (const timePoint of timePoints) {
    // 确定该时间点对应的槽类型
    const slotType = this.getSlotTypeForRange(range);
    const slotStart = this.getSlotStart(timePoint, slotType);
    const slotKey = `${slotType}_${slotStart}`;

    // 先检查内存
    let slotData = this.currentStats.get(slotKey);

    // 如果内存中没有，从文件加载
    if (!slotData) {
      slotData = await this.loadSlotFromFile(slotKey);
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
      successRate: 0
    };
  }

  const avgResponseTime = slot.responseTimes.length > 0
    ? slot.responseTimes.reduce((sum, time) => sum + time, 0) / slot.responseTimes.length
    : 0;

  const successRate = slot.requests > 0
    ? ((slot.requests - slot.errors) / slot.requests) * 100
    : 0;

  return {
    timestamp: timePoint.toISOString(),
    requests: slot.requests,
    errors: slot.errors,
    avgResponseTime: Math.round(avgResponseTime),
    successRate: Math.round(successRate * 100) / 100
  };
}
```

### 4. 文件管理与清理

```typescript
class FileStorageManager {
  private readonly STORAGE_CONFIG = {
    dataDir: './data/stats/',
    retentionHours: 24,
    cleanupIntervalMs: 60 * 60 * 1000 // 每小时清理一次
  };

  constructor() {
    this.ensureDataDirectory();
    this.startCleanupScheduler();
  }

  private async ensureDataDirectory() {
    try {
      await mkdir(this.STORAGE_CONFIG.dataDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create data directory:', error);
    }
  }

  private startCleanupScheduler() {
    setInterval(() => {
      this.cleanupOldFiles().catch(console.error);
    }, this.STORAGE_CONFIG.cleanupIntervalMs);
  }

  private async cleanupOldFiles() {
    try {
      const files = await readdir(this.STORAGE_CONFIG.dataDir);
      const now = Date.now();
      const retentionMs = this.STORAGE_CONFIG.retentionHours * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const timestamp = this.extractTimestampFromFilename(file);
        if (timestamp && now - timestamp > retentionMs) {
          await unlink(path.join(this.STORAGE_CONFIG.dataDir, file));
          console.log(`Cleaned up old file: ${file}`);
        }
      }
    } catch (error) {
      console.error('File cleanup failed:', error);
    }
  }

  private extractTimestampFromFilename(filename: string): number | null {
    // 从文件名中提取时间戳，例如: "minute_1697123400000.json"
    const match = filename.match(/(\w+)_(\d+)\.json$/);
    return match ? parseInt(match[2], 10) : null;
  }
}
```

### 5. API 接口更新

```typescript
// 后端 API Handler
export class StatsHandler {
  static getHistory(req: Request): Response {
    const url = new URL(req.url);
    const range = url.searchParams.get('range') as TimeRange || '1h';

    const historyData = await statsCollector.getHistoryData(range);

    // 转换为前端需要的格式
    const result: StatsHistory = {
      timestamps: historyData.map(d => d.timestamp),
      requests: historyData.map(d => d.requests),
      errors: historyData.map(d => d.errors),
      responseTime: historyData.map(d => d.avgResponseTime),
      successRate: historyData.map(d => d.successRate)
    };

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 前端 API 客户端
export async function getStatsHistory(range: '1h' | '12h' | '24h' = '1h'): Promise<StatsHistory> {
  return api.get<StatsHistory>(`/stats/history?range=${range}`);
}

// 类型定义更新
export interface StatsHistory {
  timestamps: string[];
  requests: number[];
  errors: number[];
  responseTime: number[];
  successRate: number[];  // 新增字段
}
```

### 6. 前端组件更新

```typescript
// MonitoringCharts.svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getStatsHistory } from '../api/stats';

  let selectedRange: '1h' | '12h' | '24h' = '1h';
  let history: StatsHistory | null = null;

  async function loadHistory() {
    try {
      loading = true;
      history = await getStatsHistory(selectedRange);
      error = null;
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  // 时间标签格式化
  $: timeLabels = history?.timestamps.map(ts => {
    const date = new Date(ts);
    switch (selectedRange) {
      case '1h':
        return date.toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit'
        });
      case '12h':
        return date.toLocaleString('zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      case '24h':
        return date.toLocaleString('zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit'
        });
    }
  }) || [];

  // 数据直接使用，无需差值计算
  $: requestsData = history?.requests || [];
  $: errorsData = history?.errors || [];
  $: responseTimeData = history?.responseTime || [];
  $: successRateData = history?.successRate || [];
</script>

<!-- 时间范围选择器 -->
<div class="join">
  <input
    class="join-item btn btn-sm"
    type="radio"
    name="range"
    aria-label="1小时"
    value="1h"
    bind:group={selectedRange}
  />
  <input
    class="join-item btn btn-sm"
    type="radio"
    name="range"
    aria-label="12小时"
    value="12h"
    bind:group={selectedRange}
  />
  <input
    class="join-item btn btn-sm"
    type="radio"
    name="range"
    aria-label="24小时"
    value="24h"
    bind:group={selectedRange}
  />
</div>
```

## 性能优化

### 1. 批量写入优化

```typescript
class BatchWriter {
  private pendingWrites = new Map<string, TimeSlotData>();
  private writeTimer: number | null = null;

  scheduleWrite(slotKey: string, data: TimeSlotData) {
    this.pendingWrites.set(slotKey, data);

    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }

    this.writeTimer = setTimeout(() => {
      this.flushWrites();
    }, 5000); // 5秒批量写入
  }

  private async flushWrites() {
    const entries = Array.from(this.pendingWrites.entries());
    this.pendingWrites.clear();

    await Promise.all(
      entries.map(([key, data]) => this.writeFile(key, data))
    );
  }
}
```

### 2. 文件缓存

```typescript
class FileCache {
  private cache = new Map<string, { data: TimeSlotData; timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

  async get(slotKey: string): Promise<TimeSlotData | null> {
    const cached = this.cache.get(slotKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const data = await this.loadFromFile(slotKey);
    if (data) {
      this.cache.set(slotKey, { data, timestamp: Date.now() });
    }

    return data;
  }
}
```

## 实施计划

### 阶段一：基础架构 (第1-2天)
- [ ] 创建新的数据结构定义
- [ ] 实现 `TimeSlotData` 和 `AggregatedDataPoint` 类型
- [ ] 建立文件存储目录结构
- [ ] 实现基础的文件读写功能

### 阶段二：数据收集 (第3-4天)
- [ ] 重构 `StatsCollector` 为 `PersistentStatsCollector`
- [ ] 实现时间槽的创建和更新逻辑
- [ ] 添加响应时间采样机制
- [ ] 实现异步文件持久化

### 阶段三：数据查询 (第5-6天)
- [ ] 实现连续时间点生成算法
- [ ] 开发混合数据源查询逻辑（内存+文件）
- [ ] 实现数据聚合和格式转换
- [ ] 更新后端 API 接口

### 阶段四：前端更新 (第7天)
- [ ] 更新前端 API 客户端
- [ ] 修改 MonitoringCharts 组件
- [ ] 调整时间标签格式化逻辑
- [ ] 更新图表数据处理

### 阶段五：优化与测试 (第8-9天)
- [ ] 实现批量写入优化
- [ ] 添加文件缓存机制
- [ ] 实现文件清理调度器
- [ ] 性能测试和内存监控

### 阶段六：部署与监控 (第10天)
- [ ] 生产环境部署
- [ ] 监控内存使用情况
- [ ] 验证数据完整性
- [ ] 性能基准测试

## 监控指标

### 内存使用
- 目标：<1KB 稳定内存占用
- 监控：`process.memoryUsage().heapUsed`
- 告警：超过5KB时触发

### 文件IO性能
- 写入延迟：<10ms (99%ile)
- 读取延迟：<50ms (99%ile)
- 磁盘使用：<100MB/天

### 数据完整性
- 文件写入成功率：>99.9%
- 数据查询成功率：>99.95%
- 时间连续性：100%覆盖

## 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 文件写入失败 | 中 | 中 | 重试机制 + 降级到内存 |
| 磁盘空间不足 | 低 | 高 | 自动清理 + 监控告警 |
| 文件损坏 | 低 | 中 | 优雅降级 + 备份策略 |
| 查询性能下降 | 中 | 低 | 文件缓存 + 批量优化 |

## 总结

轻量持久化方案通过最小化内存使用和文件存储结合，为 Dashboard 监控功能提供了可靠、高效的数据管理解决方案。该方案特别适合反向代理这类对内存敏感的基础设施服务，在保证数据完整性的同时最大化系统性能。

通过分阶段实施和持续监控，可以确保重构过程平稳进行，最终实现用户友好的长期监控图表功能。