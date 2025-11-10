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

  static reload(): Response {
    // 配置重载通过修改config.json文件触发fs.watch实现
    // 这里返回提示信息
    return new Response(
      JSON.stringify({
        success: true,
        message: 'To reload configuration, please update the config.json file. The system will automatically detect changes and reload.'
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  static restart(): Response {
    try {
      // 检查是否支持进程内重启
      // DAEMON_MODE=true 表示运行在 CLI daemon 或 Docker (with tini) 环境
      const isDaemonMode = process.env.DAEMON_MODE === 'true';

      if (!isDaemonMode) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Restart is only available in daemon mode. Please restart manually using "bungee restart" or restart your development server.'
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 获取当前主进程的 PID
      const masterPid = process.pid;

      // 查找真正的 Master 进程
      // 如果当前是 worker，需要找到 parent process
      let targetPid = masterPid;

      // 检查是否是 worker 进程
      if (process.env.BUNGEE_ROLE === 'worker') {
        // Worker 进程，向父进程（Master）发送信号
        targetPid = process.ppid;
      }

      if (!targetPid) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Unable to determine master process PID'
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 发送 SIGUSR2 信号触发重启
      process.kill(targetPid, 'SIGUSR2');

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Restart signal sent. Service will restart shortly with graceful shutdown.'
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Failed to send restart signal: ${error.message}`
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
}
