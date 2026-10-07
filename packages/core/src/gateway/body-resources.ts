function positive(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
export const DEFAULT_BODY_PARSER_BYTES = 50 * 1024 * 1024;
/** Worker budgets, never a per-request business size limit. */
export const bodyResources = Object.freeze({
  workerMemoryBytes: positive('BUNGEE_BODY_WORKER_MEMORY_BYTES', 512 * 1024 * 1024),
  optionalMemoryBytes: positive('BUNGEE_BODY_OPTIONAL_MEMORY_BYTES', 256 * 1024 * 1024),
  observerBacklogBytes: positive('BUNGEE_BODY_OBSERVER_BACKLOG_BYTES', 32 * 1024 * 1024),
  observerBacklogEvents: positive('BUNGEE_BODY_OBSERVER_BACKLOG_EVENTS', 1024),
  // Eight 800 KiB mixed-content and 2 MiB compressed consumers passed calibration.
  mandatoryDecoders: positive('BUNGEE_BODY_MANDATORY_DECODERS', 8),
  optionalDecoders: positive('BUNGEE_BODY_OPTIONAL_DECODERS', 8),
  loggerMemoryBytes: positive('BUNGEE_BODY_LOG_MEMORY_BYTES', 32 * 1024 * 1024),
  loggerConsumers: positive('BUNGEE_BODY_LOG_CONSUMERS', 64),
  callbackMs: positive('BUNGEE_BODY_CALLBACK_MS', 250),
  optionalDecodeMs: positive('BUNGEE_BODY_OPTIONAL_DECODE_MS', 1000),
  zstdWindowLog: positive('BUNGEE_BODY_ZSTD_WINDOW_LOG', 23),
});
export const bodyMetrics = { retainedBytes: 0, optionalBytes: 0, loggerBytes: 0, peakBytes: 0, activeDecoders: 0, activeOptionalDecoders: 0, decompressions: 0, jsonParses: 0, sseParses: 0 };
export function snapshotBodyResources() { return { ...bodyMetrics }; }
