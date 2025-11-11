import type { TimeSlotData } from '../types';
import { fileStorageManager } from './file-storage';

export class BatchWriter {
  private pendingWrites = new Map<string, TimeSlotData>();
  private writeTimer: Timer | null = null;
  private readonly BATCH_DELAY = 5000; // 5秒批量写入

  scheduleWrite(slotKey: string, data: TimeSlotData) {
    this.pendingWrites.set(slotKey, data);

    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }

    this.writeTimer = setTimeout(() => {
      this.flushWrites().catch(console.error);
    }, this.BATCH_DELAY);
  }

  private async flushWrites() {
    const entries = Array.from(this.pendingWrites.entries());
    this.pendingWrites.clear();
    this.writeTimer = null;

    if (entries.length === 0) return;

    console.log(`Batch writing ${entries.length} slots to disk`);

    // 并行写入所有待处理的槽
    const writePromises = entries.map(([key, data]) =>
      fileStorageManager.writeSlot(key, data).catch(error => {
        console.error(`Failed to write slot ${key} in batch:`, error);
        return false;
      })
    );

    const results = await Promise.all(writePromises);
    const successCount = results.filter(success => success).length;

    console.log(`Batch write completed: ${successCount}/${entries.length} successful`);
  }

  // ���制刷新所有待写入的数据
  async forceFlush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flushWrites();
  }
}

export const batchWriter = new BatchWriter();