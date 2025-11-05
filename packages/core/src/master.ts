import path from "path";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import { logger } from "./logger";
import { logCleanupService } from "./logger/log-cleanup";
import { MigrationManager } from "./migrations";
import { loadConfig } from "./config";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(process.cwd(), "config.json");
const WORKER_COUNT = process.env.WORKER_COUNT
  ? parseInt(process.env.WORKER_COUNT)
  : 2;
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8088;

interface WorkerInfo {
  process: ChildProcess;
  workerId: number;
  status: "starting" | "ready" | "shutting_down" | "stopped";
  exitPromise?: Promise<void>;
  exitResolve?: () => void;
}

class Master {
  private workers = new Map<number, WorkerInfo>();
  private config: any;
  private isReloading = false;
  private reloadTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.loadAndStart();
    this.watchConfig();
    this.handleSignals();

    // 启动日志清理服务（仅在主进程）
    logCleanupService.start();
  }

  private async loadAndStart() {
    try {
      // Use loadConfig() which handles auto-creation of config file
      this.config = await loadConfig(CONFIG_PATH);
      logger.info("Configuration loaded successfully.");

      // === Execute database migrations ===
      const dbPath = path.resolve(process.cwd(), "logs", "access.db");
      const migrationManager = new MigrationManager(dbPath);

      logger.info("Running database migrations...");
      const migrationResult = await migrationManager.migrate();

      if (!migrationResult.success) {
        // Migration failed, but don't stop the application
        logger.warn(
          {
            fallback: migrationResult.fallback,
            error: migrationResult.error,
          },
          "Database migration failed, running in degraded mode"
        );

        // Display user-friendly warning using logger
        logger.error("\n⚠️  数据库升级失败");
        logger.error(`   ${migrationResult.userMessage}`);
        logger.error("   应用将继续运行，但日志功能可能受限。\n");
      } else {
        logger.info("Database migrations completed successfully");
      }

      await this.startWorkers();
    } catch (error) {
      logger.error({ error }, "Failed to load or parse config.json");
      process.exit(1);
    }
  }

  private async startWorkers() {
    logger.info(`Starting ${WORKER_COUNT} worker processes...`);

    // 串行启动 worker 进程，避免端口竞争
    for (let i = 0; i < WORKER_COUNT; i++) {
      const success = await this.forkWorker(i);
      if (!success) {
        logger.error(
          `Failed to start worker #${i}. Continuing with remaining workers.`
        );
      }
      // 添加小延迟以避免端口竞争
      if (i < WORKER_COUNT - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    logger.info("All workers have been started.");
  }

  private forkWorker(workerId: number): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        // Use environment variables to identify worker role
        const env = {
          ...process.env,
          BUNGEE_ROLE: "worker",
          WORKER_ID: String(workerId),
          PORT: String(PORT),
          CONFIG_PATH: CONFIG_PATH,
        };

        // Spawn worker process
        const workerProcess = spawn(process.execPath, process.argv.slice(1), {
          env,
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        });

        logger.info(
          `Starting worker #${workerId} with PID ${workerProcess.pid}`
        );

        let exitResolve: (() => void) | undefined;
        const exitPromise = new Promise<void>((res) => {
          exitResolve = res;
        });

        const workerInfo: WorkerInfo = {
          process: workerProcess,
          workerId,
          status: "starting",
          exitPromise,
          exitResolve,
        };

        this.workers.set(workerId, workerInfo);

        // Set a timeout for worker startup
        const startupTimeout = setTimeout(() => {
          logger.error(
            `Worker #${workerId} (PID: ${workerProcess.pid}) failed to start within timeout`
          );
          workerProcess.kill();
          this.workers.delete(workerId);
          resolve(false);
        }, 30000); // 30 second timeout

        workerProcess.on("exit", (code) => {
          clearTimeout(startupTimeout);

          const wasStarting = workerInfo.status === "starting";

          if (workerInfo.status === "shutting_down") {
            logger.info(
              `Worker #${workerId} (PID: ${workerProcess.pid}) exited gracefully (code: ${code}).`
            );
          } else {
            logger.warn(
              `Worker #${workerId} (PID: ${workerProcess.pid}) exited unexpectedly with code ${code}.`
            );
          }

          this.workers.delete(workerId);
          workerInfo.status = "stopped";

          // Resolve the exit promise
          if (exitResolve) {
            exitResolve();
          }

          if (wasStarting) {
            resolve(false);
          }
        });

        workerProcess.on("message", (message: any) => {
          clearTimeout(startupTimeout);
          if (message.status === "ready") {
            logger.info(
              `Worker #${workerId} (PID: ${workerProcess.pid}) reported ready.`
            );
            workerInfo.status = "ready";
            resolve(true);
          } else if (message.status === "error") {
            const errorMsg = message.error || "Unknown error";
            logger.error(
              `Worker #${workerId} (PID: ${workerProcess.pid}) reported an error: ${errorMsg}`
            );
            workerProcess.kill();
            this.workers.delete(workerId);
            resolve(false);
          }
        });

        workerProcess.on("error", (error) => {
          clearTimeout(startupTimeout);
          logger.error({ error }, `Worker #${workerId} encountered an error`);
          workerProcess.kill();
          this.workers.delete(workerId);
          resolve(false);
        });
      } catch (error) {
        logger.error({ error }, `Failed to create worker #${workerId}`);
        resolve(false);
      }
    });
  }

  private watchConfig() {
    fs.watch(CONFIG_PATH, (eventType) => {
      if (eventType === "change") {
        logger.info("config.json changed. Scheduling reload...");

        // Debounce: wait 300ms for additional changes
        if (this.reloadTimeout) {
          clearTimeout(this.reloadTimeout);
        }

        this.reloadTimeout = setTimeout(() => {
          if (!this.isReloading) {
            this.gracefulReload();
          }
        }, 300);
      }
    });
  }

  private async gracefulReload() {
    if (this.isReloading) {
      logger.warn("Reload already in progress. Skipping...");
      return;
    }

    this.isReloading = true;
    logger.info("Starting graceful reload...");

    try {
      // Validate new configuration
      const configContent = await fs.promises.readFile(CONFIG_PATH, "utf-8");
      const newConfig = JSON.parse(configContent);

      if (!newConfig.routes || !Array.isArray(newConfig.routes)) {
        throw new Error(
          'New configuration is invalid: "routes" is missing or not an array.'
        );
      }

      logger.info("New configuration validated successfully.");

      // Rolling restart strategy: "Stop-then-Start"
      const currentWorkers = Array.from(this.workers.values());

      for (let i = 0; i < currentWorkers.length; i++) {
        const oldWorker = currentWorkers[i];
        logger.info(`Restarting worker #${oldWorker.workerId}...`);

        // Step 1: Gracefully shutdown the old worker
        await this.gracefulShutdownWorker(oldWorker);

        // Step 2: Start new worker with same ID
        const newWorkerStarted = await this.forkWorker(oldWorker.workerId);

        if (!newWorkerStarted) {
          logger.error(
            `Failed to start new worker #${oldWorker.workerId}. Aborting reload to maintain service availability.`
          );

          // Try to restart the remaining workers that we haven't touched yet
          for (let j = i + 1; j < currentWorkers.length; j++) {
            const remainingWorker = currentWorkers[j];
            if (this.workers.has(remainingWorker.workerId)) {
              // This worker is still running, keep it
              continue;
            }
            // This worker was already shut down, try to restart it
            await this.forkWorker(remainingWorker.workerId);
          }

          this.isReloading = false;
          return;
        }

        logger.info(`Worker #${oldWorker.workerId} restarted successfully.`);
      }

      this.config = newConfig;
      logger.info("Graceful reload completed successfully.");
    } catch (error) {
      logger.error({ error }, "Failed to reload configuration");
      logger.info("Sticking with the old configuration.");
    } finally {
      this.isReloading = false;
    }
  }

  private async gracefulShutdownWorker(workerInfo: WorkerInfo): Promise<void> {
    if (workerInfo.status === "stopped") {
      return;
    }

    workerInfo.status = "shutting_down";

    // Send shutdown command
    if (workerInfo.process.send) {
      workerInfo.process.send({ command: "shutdown" });
    }

    // Set timeout for graceful shutdown
    const shutdownTimeout = setTimeout(() => {
      logger.warn(
        `Worker #${workerInfo.workerId} did not shut down gracefully. Force terminating.`
      );
      workerInfo.process.kill("SIGTERM");
    }, 30000); // 30 second timeout

    // Wait for the exit event using the existing exitPromise
    if (workerInfo.exitPromise) {
      await workerInfo.exitPromise;
    }

    clearTimeout(shutdownTimeout);
  }

  private handleSignals() {
    const handle = (signal: NodeJS.Signals) => {
      logger.info(`Received ${signal}. Shutting down master and workers...`);
      this.shutdownAllWorkers();
      process.exit(0);
    };

    const handleRestart = async () => {
      logger.info('Received restart signal (SIGUSR2). Initiating graceful restart...');

      // 在关闭前启动新的主进程
      try {
        const { spawn } = await import('child_process');
        const newMaster = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: 'inherit',
          env: process.env,
          cwd: process.cwd(),
        });

        newMaster.unref();
        logger.info(`New master process spawned with PID ${newMaster.pid}`);

        // 给新进程一点启动时间
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error({ error }, 'Failed to spawn new master process');
      }

      // 关闭旧进程的所有 worker
      await this.shutdownAllWorkers();
      logger.info('Old master process exiting...');
      process.exit(0);
    };

    process.on("SIGINT", handle);
    process.on("SIGTERM", handle);
    process.on("SIGUSR2", handleRestart);
  }

  private async shutdownAllWorkers() {
    logger.info(`Shutting down ${this.workers.size} workers.`);
    const shutdownPromises = Array.from(this.workers.values()).map(
      (workerInfo) => this.gracefulShutdownWorker(workerInfo)
    );
    await Promise.all(shutdownPromises);
    this.workers.clear();

    // 停止日志清理服务
    logCleanupService.stop();
  }
}

new Master();
