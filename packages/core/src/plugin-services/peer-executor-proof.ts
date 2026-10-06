import type { CommandSourceIdentity } from './command-journal';
import type { CapturedProcessIdentity } from '../master-runtime/process-identity';

/** Host-authored, authenticated evidence; PID or controller epoch alone is insufficient. */
export interface PluginExecutorProof {
  readonly source: CommandSourceIdentity;
  readonly physical: CapturedProcessIdentity;
  readonly boot: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MARKER = new RegExp(`^${UUID}$`);
const BOOT = new RegExp(`^(?:linux:${UUID}|win32:${UUID}|darwin:[0-9]+:[0-9]+)$`);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Input has already passed the bounded, accessor-free RPC JSON decoder. */
export function decodePluginExecutorProof(value: unknown): PluginExecutorProof | null {
  if (!object(value) || Object.keys(value).length !== 3 || !object(value.source) || !object(value.physical)) return null;
  const { source, physical, boot } = value;
  if (Object.keys(source).length !== 4 || source.process !== 'control'
    || !text(source.instance, 128) || !text(source.catalog, 256)
    || !Number.isSafeInteger(source.generation) || (source.generation as number) < 1
    || Object.keys(physical).length !== 4 || !Number.isSafeInteger(physical.pid) || (physical.pid as number) <= 0
    || !text(physical.startToken, 256) || !text(physical.executable, 4096)
    || !text(physical.processInstanceId, 36) || !MARKER.test(physical.processInstanceId)
    || typeof boot !== 'string' || !BOOT.test(boot)) return null;
  return Object.freeze({
    source: Object.freeze({ process: 'control', instance: source.instance, catalog: source.catalog, generation: source.generation as number }),
    physical: Object.freeze({ pid: physical.pid as number, startToken: physical.startToken, executable: physical.executable, processInstanceId: physical.processInstanceId }),
    boot,
  });
}
