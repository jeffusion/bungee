import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

type LoggerContext = Readonly<Record<string, unknown>>;

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
  child(bindings: LoggerContext): Logger;
}

const pinoStyleConsoleFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  let output = `${timestamp} ${level}`;
  if (message) output += `: ${message}`;
  const metadata = Object.fromEntries(
    Object.entries(meta).filter(([key]) => key !== 'level' && key !== 'timestamp'),
  );
  if (Object.keys(metadata).length > 0) output += ` ${JSON.stringify(metadata)}`;
  return output;
});

let initializedLogger: winston.Logger | null = null;

function getLogger(): winston.Logger {
  if (initializedLogger !== null) return initializedLogger;
  const logLevel = process.env.LOG_LEVEL ?? 'info';
  const transports: winston.transport[] = [];
  if (process.env.BUNGEE_ROLE !== 'worker' && process.env.NODE_ENV === 'production') {
    const logsDir = path.resolve(process.cwd(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    transports.push(new DailyRotateFile({
      filename: path.join(logsDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m',
      maxFiles: '5d',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      level: logLevel,
    }));
  }
  if (process.env.NODE_ENV !== 'production') {
    transports.push(new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.colorize({ all: false, level: true }),
        pinoStyleConsoleFormat,
      ),
      level: logLevel,
    }));
  }
  initializedLogger = winston.createLogger({ level: logLevel, transports });
  return initializedLogger;
}

function createLogMethod(level: string, defaultMeta: LoggerContext = {}) {
  return (objOrMsg: LoggerContext | string, msg?: string): void => {
    if (typeof objOrMsg === 'string') {
      getLogger().log(level, objOrMsg, defaultMeta);
      return;
    }
    getLogger().log(level, msg ?? '', { ...defaultMeta, ...objOrMsg });
  };
}

function createLogger(defaultMeta: LoggerContext = {}): Logger {
  return {
    info: createLogMethod('info', defaultMeta),
    warn: createLogMethod('warn', defaultMeta),
    error: createLogMethod('error', defaultMeta),
    debug: createLogMethod('debug', defaultMeta),
    fatal: createLogMethod('error', defaultMeta),
    child: (bindings) => createLogger({ ...defaultMeta, ...bindings }),
  };
}

export const logger: Logger = createLogger();
