import type { SystemInfo } from '../types';

// 全局变量用于存储系统启动时间
const startTime = Date.now();

// 版本信息从环境变量获取，或使用默认值
const version = process.env.npm_package_version || '1.0.0';

export class SystemHandler {
  static getInfo(): Response {
    const uptime = (Date.now() - startTime) / 1000; // 秒

    const info: SystemInfo = {
      version: version,
      uptime: uptime,
      workers: [] // Worker信息由Master进程管理，暂时返回空数组
    };

    return new Response(JSON.stringify(info), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
