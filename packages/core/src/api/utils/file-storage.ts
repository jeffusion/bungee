import { mkdir, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { TimeSlotData } from '../types';
import { STORAGE_CONFIG } from '../constants';

export class FileStorageManager {
  private readonly config = STORAGE_CONFIG;

  constructor() {
    this.ensureDataDirectory();
    this.startCleanupScheduler();
  }

  private async ensureDataDirectory() {
    try {
      if (!existsSync(this.config.dataDir)) {
        await mkdir(this.config.dataDir, { recursive: true });
        console.log(`Created data directory: ${this.config.dataDir}`);
      }
    } catch (error) {
      console.error('Failed to create data directory:', error);
    }
  }

  private startCleanupScheduler() {
    setInterval(() => {
      this.cleanupOldFiles().catch(console.error);
    }, 60 * 60 * 1000);
  }

  async writeSlot(slotKey: string, slot: TimeSlotData): Promise<boolean> {
    const filename = `${slotKey}.json`;
    const filepath = path.join(this.config.dataDir, filename);

    try {
      await Bun.write(filepath, JSON.stringify(slot));
      console.log(`Persisted slot: ${filename}`);
      return true;
    } catch (error) {
      console.error(`Failed to persist slot: ${filename}`, error);
      return false;
    }
  }

  async readSlot(slotKey: string): Promise<TimeSlotData | null> {
    const filename = `${slotKey}.json`;
    const filepath = path.join(this.config.dataDir, filename);

    try {
      if (!existsSync(filepath)) {
        return null;
      }

      const file = Bun.file(filepath);
      const content = await file.text();
      return JSON.parse(content) as TimeSlotData;
    } catch (error) {
      console.error(`Failed to read slot: ${filename}`, error);
      return null;
    }
  }

  private async cleanupOldFiles() {
    try {
      if (!existsSync(this.config.dataDir)) {
        return;
      }

      const files = await readdir(this.config.dataDir);
      const now = Date.now();
      const retentionMs = this.config.retentionHours * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const timestamp = this.extractTimestampFromFilename(file);
        if (timestamp && now - timestamp > retentionMs) {
          await unlink(path.join(this.config.dataDir, file));
          console.log(`Cleaned up old file: ${file}`);
        }
      }
    } catch (error) {
      console.error('File cleanup failed:', error);
    }
  }

  private extractTimestampFromFilename(filename: string): number | null {
    // 从文件名中提取时间戳，例如: "minute_1697123400000.json"
    const match = filename.match(/(minute|halfHour|hour)_(\d+)\.json$/);
    return match ? parseInt(match[2], 10) : null;
  }
}

// 创建单例实例
export const fileStorageManager = new FileStorageManager();
