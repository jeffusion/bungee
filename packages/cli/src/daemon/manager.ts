import fs from 'fs';
import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { ConfigPaths } from '../config/paths';
import { BinaryManager } from '../binary/manager';
import { createDaemonRuntime } from './runtime';

type StartOptions = {
  readonly workers?: string;
  readonly port?: string;
  readonly autoUpgrade?: boolean;
};

type DaemonSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => Pick<ChildProcess, 'pid' | 'unref'>;

type ProcessControl = {
  readonly kill: (pid: number, signal: NodeJS.Signals | number) => void;
};

export class DaemonManager {
  private configDir: string;
  private pidFile: string;
  private logFile: string;
  private errorLogFile: string;
  private stopTimeoutMs = 30_000;

  constructor(
    private readonly spawnDaemon: DaemonSpawn = spawn,
    private readonly processControl: ProcessControl = {
      kill: (pid, signal) => process.kill(pid, signal),
    },
  ) {
    this.configDir = ConfigPaths.CONFIG_DIR;
    this.pidFile = ConfigPaths.PID_FILE;
    this.logFile = ConfigPaths.LOG_FILE;
    this.errorLogFile = ConfigPaths.ERROR_LOG_FILE;

    // 确保配置目录存在
    ConfigPaths.ensureConfigDir();
    ConfigPaths.ensureDataDir();
    ConfigPaths.ensureLogsDir();
  }

  async isRunning(): Promise<boolean> {
    return (await this.getPid()) !== null;
  }

  async getPid(): Promise<number | null> {
    try {
      if (!fs.existsSync(this.pidFile)) {
        return null;
      }

      const pidContent = await fs.promises.readFile(this.pidFile, 'utf-8');
      const normalizedPid = pidContent.trim();
      if (!/^\d+$/.test(normalizedPid)) return null;
      const pid = Number(normalizedPid);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  async start(options: StartOptions = {}): Promise<void> {
    if (await this.isRunning()) {
      throw new Error('Bungee is already running. Use "bungee status" to check status.');
    }

    // 确保二进制文件存在（如果不存在会自动下载）
    const binaryPath = await BinaryManager.ensureBinary({
      autoUpgrade: options.autoUpgrade,
    });

    // 打开日志文件（使用文件描述符，因为 detached 进程不能使用流）
    const logFd = fs.openSync(this.logFile, 'a');
    const errorLogFd = fs.openSync(this.errorLogFile, 'a');

    const runtime = createDaemonRuntime({
      dataDirectory: ConfigPaths.DATA_DIR,
      logsDirectory: ConfigPaths.LOGS_DIR,
      workers: options.workers,
      port: options.port,
      inheritedEnvironment: process.env,
    });

    // 启动守护进程 - 直接运行二进制文件
    const child = this.spawnDaemon(binaryPath, [], {
      detached: true,
      stdio: ['ignore', logFd, errorLogFd],
      env: runtime.env,
      cwd: runtime.cwd,
    });

    // 关闭父进程中的文件描述符（子进程会继承）
    fs.closeSync(logFd);
    fs.closeSync(errorLogFd);

    // 让子进程独立运行
    child.unref();

    // 保存PID
    if (child.pid === undefined) throw new Error('Daemon process did not return a PID');
    await fs.promises.writeFile(this.pidFile, child.pid.toString());

    // 等待一小段时间确认启动成功
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (!(await this.isRunning())) {
      // 读取错误日志
      let errorMsg = 'Failed to start daemon';
      try {
        const errorLog = await fs.promises.readFile(this.errorLogFile, 'utf-8');
        const lastError = errorLog.split('\n').filter(line => line.trim()).slice(-5).join('\n');
        if (lastError) {
          errorMsg += `:\n${lastError}`;
        }
      } catch {
        // ignore
      }
      throw new Error(errorMsg);
    }

    console.log('✅ Bungee daemon started successfully');
    console.log(`📋 PID: ${child.pid}`);
    console.log(`💾 Data: ${ConfigPaths.DATA_DIR}`);
    console.log(`📝 Logs: ${this.logFile}`);
  }

  async stop(): Promise<void> {
    const pid = await this.getPid();
    if (pid === null) {
      throw new Error('Bungee is not running');
    }

    try {
      this.processControl.kill(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        this.clearPidFile();
        console.log('✅ Bungee daemon was not running');
        return;
      } else {
        throw error;
      }
    }

    const deadline = Date.now() + this.stopTimeoutMs;
    while (true) {
      try {
        this.processControl.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          this.clearPidFile();
          console.log('✅ Bungee daemon stopped successfully');
          return;
        }
        throw error;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Failed to stop daemon within ${this.stopTimeoutMs / 1000} seconds; PID file retained`);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining)));
    }
  }

  private clearPidFile(): void {
    if (fs.existsSync(this.pidFile)) fs.unlinkSync(this.pidFile);
  }

  async restart(options: StartOptions = {}): Promise<void> {
    console.log('🔄 Restarting Bungee daemon...');

    if (await this.isRunning()) await this.stop();

    // 等待一下确保完全停止
    await new Promise(resolve => setTimeout(resolve, 1000));

    await this.start(options);
  }

  async getStatus(): Promise<{
    running: boolean;
    pid?: number;
    configDir: string;
    logFile: string;
    errorLogFile: string;
  }> {
    const pid = await this.getPid();
    const running = pid !== null;

    return {
      running,
      ...(pid !== null ? { pid } : {}),
      configDir: this.configDir,
      logFile: this.logFile,
      errorLogFile: this.errorLogFile,
    };
  }

  async getLogs(lines: number = 50, follow: boolean = false): Promise<void> {
    if (!fs.existsSync(this.logFile)) {
      console.log('No logs found. Make sure Bungee is running or has been started.');
      return;
    }

    if (follow) {
      // 实现简单的tail -f功能
      const { spawn } = await import('child_process');
      const tail = spawn('tail', ['-f', '-n', lines.toString(), this.logFile], {
        stdio: 'inherit'
      });

      process.on('SIGINT', () => {
        tail.kill();
        process.exit(0);
      });
    } else {
      // 读取最后N行
      const content = await fs.promises.readFile(this.logFile, 'utf-8');
      const allLines = content.split('\n');
      const lastLines = allLines.slice(-lines).join('\n');
      console.log(lastLines);
    }
  }
}
