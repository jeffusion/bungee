import fs from 'fs';
import path from 'path';
import type { ValidationResult } from '../types';

const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json');
const MAX_BACKUPS = 5; // 最多保留的备份文件数量

export class ConfigHandler {
  static get(): Response {
    try {
      const configContent = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(configContent);

      return new Response(JSON.stringify(config), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      return new Response(
        JSON.stringify({ error: 'Failed to read config: ' + error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  static async update(req: Request): Promise<Response> {
    try {
      const newConfig = await req.json();

      // 验证配置
      const validation = this.validateConfig(newConfig);
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: validation.error }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 备份旧配置
      const backupPath = `${CONFIG_PATH}.backup.${Date.now()}`;
      fs.copyFileSync(CONFIG_PATH, backupPath);

      // 清理旧备份
      this.cleanupOldBackups();

      // 写入新配置（移除运行时字段）
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.sanitizeConfig(newConfig), null, 2));

      // 配置更新会触发 fs.watch，Master会自动重载

      return new Response(
        JSON.stringify({ success: true, message: 'Config updated, reloading workers...' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  static async validate(req: Request): Promise<Response> {
    try {
      const config = await req.json();
      const validation = this.validateConfig(config);

      return new Response(JSON.stringify(validation), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      return new Response(
        JSON.stringify({ valid: false, error: error.message }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private static validateConfig(config: any): ValidationResult {
    if (!config) {
      return { valid: false, error: 'Config cannot be empty' };
    }

    if (!config.routes || !Array.isArray(config.routes)) {
      return { valid: false, error: 'routes must be an array' };
    }

    if (config.routes.length === 0) {
      return { valid: false, error: 'At least one route is required' };
    }

    for (let i = 0; i < config.routes.length; i++) {
      const route = config.routes[i];

      if (!route.path) {
        return { valid: false, error: `Route #${i + 1}: path is required` };
      }

      if (!route.upstreams || !Array.isArray(route.upstreams)) {
        return { valid: false, error: `Route "${route.path}": upstreams must be an array` };
      }

      if (route.upstreams.length === 0) {
        return { valid: false, error: `Route "${route.path}": at least one upstream is required` };
      }

      for (let j = 0; j < route.upstreams.length; j++) {
        const upstream = route.upstreams[j];

        if (!upstream.target) {
          return { valid: false, error: `Route "${route.path}", Upstream #${j + 1}: target is required` };
        }

        try {
          new URL(upstream.target);
        } catch {
          return { valid: false, error: `Route "${route.path}", Upstream #${j + 1}: invalid target URL "${upstream.target}"` };
        }
      }
    }

    return { valid: true };
  }

  /**
   * 移除运行时字段，只保留持久化配置
   */
  private static sanitizeConfig(config: any): any {
    return {
      ...(config.bodyParserLimit && { bodyParserLimit: config.bodyParserLimit }),
      ...(config.auth && { auth: this.sanitizeAuth(config.auth) }),
      ...(config.logging && { logging: config.logging }),
      ...(config.plugins && { plugins: config.plugins }),
      ...(config.logLevel && { logLevel: config.logLevel }),
      routes: config.routes.map((r: any) => this.sanitizeRoute(r))
    };
  }

  private static sanitizeRoute(route: any): any {
    return {
      path: route.path,
      ...(route.pathRewrite && { pathRewrite: route.pathRewrite }),
      ...(route.auth && { auth: this.sanitizeAuth(route.auth) }),
      ...(route.plugins && { plugins: route.plugins }),
      ...(route.failover && { failover: route.failover }),
      ...this.sanitizeModificationRules(route),
      upstreams: route.upstreams.map((u: any) => this.sanitizeUpstream(u))
    };
  }

  private static sanitizeUpstream(upstream: any): any {
    return {
      target: upstream.target,
      ...(upstream.weight !== undefined && { weight: upstream.weight }),
      ...(upstream.priority !== undefined && { priority: upstream.priority }),
      ...(upstream.plugins && { plugins: upstream.plugins }),
      ...this.sanitizeModificationRules(upstream)
    };
  }

  private static sanitizeModificationRules(obj: any): any {
    return {
      ...(obj.headers && { headers: obj.headers }),
      ...(obj.body && { body: obj.body })
    };
  }

  private static sanitizeAuth(auth: any): any {
    return {
      enabled: auth.enabled,
      tokens: auth.tokens
    };
  }

  /**
   * 清理旧的备份文件，只保留最近的 MAX_BACKUPS 个
   */
  private static cleanupOldBackups(): void {
    try {
      const configDir = path.dirname(CONFIG_PATH);
      const configBasename = path.basename(CONFIG_PATH);

      // 读取目录中的所有文件
      const files = fs.readdirSync(configDir);

      // 筛选出备份文件并提取时间戳
      const backups = files
        .filter(file => file.startsWith(`${configBasename}.backup.`))
        .map(file => ({
          filename: file,
          filepath: path.join(configDir, file),
          timestamp: parseInt(file.split('.backup.')[1] || '0')
        }))
        .filter(backup => !isNaN(backup.timestamp))
        .sort((a, b) => b.timestamp - a.timestamp); // 按时间戳降序排列（新的在前）

      // 删除超出数量限制的旧备份
      if (backups.length > MAX_BACKUPS) {
        const toDelete = backups.slice(MAX_BACKUPS);
        toDelete.forEach(backup => {
          try {
            fs.unlinkSync(backup.filepath);
            console.log(`Deleted old backup: ${backup.filename}`);
          } catch (err) {
            console.error(`Failed to delete backup ${backup.filename}:`, err);
          }
        });
      }
    } catch (err) {
      console.error('Failed to cleanup old backups:', err);
      // 不抛出错误，避免影响配置更新流程
    }
  }
}
