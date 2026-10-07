/** Shared process sink; the public SDK must not bundle file transports into plugins. */
type Context = Readonly<Record<string, unknown>>;
type LogMethod = { (context: Context, message?: string): void; (message: string): void };
export interface PluginLogSink {
  info: LogMethod; warn: LogMethod; error: LogMethod; debug: LogMethod; fatal: LogMethod;
  child(bindings: Context): PluginLogSink;
}
const sinkKey = Symbol.for('@jeffusion/bungee/plugin-log-sink');
export function installPluginLogSink(sink: PluginLogSink): void {
  (globalThis as Record<symbol, unknown>)[sinkKey] = sink;
}
function createLogger(bindings: Context = {}): PluginLogSink {
  const method = (level: 'info' | 'warn' | 'error' | 'debug' | 'fatal'): LogMethod =>
    (value: Context | string, message?: string) => {
      const sink = (globalThis as Record<symbol, unknown>)[sinkKey] as PluginLogSink | undefined;
      if (sink) {
        if (typeof value === 'string') sink[level](bindings, value);
        else sink[level]({...bindings, ...value}, message);
      } else if (level !== 'debug' || process.env.LOG_LEVEL === 'debug') {
        const write = level === 'fatal' ? console.error : console[level];
        write(message ?? (typeof value === 'string' ? value : ''), typeof value === 'string' ? bindings : {...bindings, ...value});
      }
    };
  return {info: method('info'), warn: method('warn'), error: method('error'), debug: method('debug'),
    fatal: method('fatal'), child: extra => createLogger({...bindings, ...extra})};
}
export const logger = createLogger();
