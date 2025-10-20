import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

/**
 * 系统日志（System Logger）
 *
 * 用于记录系统级日志：
 * - 系统启动/关闭
 * - 配置加载/验证
 * - Worker 管理
 * - Runtime state 初始化
 * - 健康检查恢复
 * - 错误和异常
 *
 * 注意：请求日志现在使用独立的 SQLite 数据库，参见 logger/access-log-writer.ts
 */

// Load environment variables first
dotenv.config();

// 确保 logs 目录存在
const logsDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logLevel = process.env.LOG_LEVEL || 'info';
const isDevelopment = process.env.NODE_ENV !== 'production';
const isMaster = process.env.BUNGEE_ROLE !== 'worker';

// Pino-style 格式化器（用于控制台）
const pinoStyleConsoleFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  // Pino 风格格式：时间戳 级别: 消息
  let output = `${timestamp} ${level}`;

  if (message) {
    output += `: ${message}`;
  }

  // 添加额外的元数据
  const metaKeys = Object.keys(meta).filter(k => !['level', 'timestamp'].includes(k));
  if (metaKeys.length > 0) {
    const metaObj: any = {};
    metaKeys.forEach(k => metaObj[k] = meta[k]);
    const metaStr = JSON.stringify(metaObj);
    output += ` ${metaStr}`;
  }

  return output;
});

// 日志传输器配置
const transports: winston.transport[] = [];

if (isMaster) {
  // 主进程：使用文件日志（按天滚动，10MB 限制，保留 5 天）
  transports.push(
    new DailyRotateFile({
      filename: path.join(logsDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '5d',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      level: logLevel,
    })
  );
}

// 控制台输出（所有进程，开发环境）
if (isDevelopment) {
  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }), // Pino 风格时间格式
        winston.format.errors({ stack: true }),
        winston.format.colorize({ all: false, level: true }), // 只给 level 着色
        pinoStyleConsoleFormat
      ),
      level: logLevel,
    })
  );
}

// 创建 winston logger
const winstonLogger = winston.createLogger({
  level: logLevel,
  transports,
});

// 创建兼容 pino 的 logger 接口
interface LoggerContext {
  [key: string]: any;
}

interface Logger {
  info(obj: LoggerContext, msg?: string): void;
  info(msg: string): void;
  warn(obj: LoggerContext, msg?: string): void;
  warn(msg: string): void;
  error(obj: LoggerContext, msg?: string): void;
  error(msg: string): void;
  debug(obj: LoggerContext, msg?: string): void;
  debug(msg: string): void;
  fatal(obj: LoggerContext, msg?: string): void;
  fatal(msg: string): void;
}

// 创建兼容 pino API 的包装器
function createLogMethod(level: string) {
  return function(objOrMsg: LoggerContext | string, msg?: string) {
    if (typeof objOrMsg === 'string') {
      // logger.info('message') 形式
      winstonLogger.log(level, objOrMsg);
    } else {
      // logger.info({ key: value }, 'message') 形式
      const message = msg || '';
      winstonLogger.log(level, message, objOrMsg);
    }
  };
}

export const logger: Logger = {
  info: createLogMethod('info'),
  warn: createLogMethod('warn'),
  error: createLogMethod('error'),
  debug: createLogMethod('debug'),
  fatal: createLogMethod('error'), // winston doesn't have fatal, map to error
};
