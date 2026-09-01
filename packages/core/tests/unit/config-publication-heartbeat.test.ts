import { describe, expect, test } from 'bun:test';
import {
  ConfigPublicationMessageError,
  parseConfigMasterMessage,
  type MasterHeartbeatCommand,
} from '../../src/config-publication';

const IDENTITY = {
  master_generation: '10000000-0000-4000-8000-000000000001',
  worker_instance_id: '20000000-0000-4000-8000-000000000001',
  worker_slot: 0,
} as const;

const HEARTBEAT: MasterHeartbeatCommand = {
  command: 'master-heartbeat',
  ...IDENTITY,
  master_pid: 4321,
  sequence: 1,
};

describe('config publication master heartbeat wire', () => {
  test('parses only exact positive-safe heartbeat fields', () => {
    // Given / When / Then
    expect(parseConfigMasterMessage(HEARTBEAT)).toEqual(HEARTBEAT);
    for (const input of [
      { ...HEARTBEAT, master_pid: 0 },
      { ...HEARTBEAT, master_pid: Number.MAX_SAFE_INTEGER + 1 },
      { ...HEARTBEAT, sequence: 0 },
      { ...HEARTBEAT, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...HEARTBEAT, extra: true },
      { command: 'master-heartbeat', ...IDENTITY, master_pid: 4321 },
    ]) {
      expect(() => parseConfigMasterMessage(input)).toThrow(ConfigPublicationMessageError);
    }
  });

  test('snapshots heartbeat without invoking accessors', () => {
    // Given
    let getterCalls = 0;
    const heartbeat = { command: 'master-heartbeat', ...IDENTITY, master_pid: 4321 };
    Object.defineProperty(heartbeat, 'sequence', {
      enumerable: true,
      get() { getterCalls += 1; return 1; },
    });

    // When / Then
    expect(() => parseConfigMasterMessage(heartbeat)).toThrow(ConfigPublicationMessageError);
    expect(getterCalls).toBe(0);
  });
});
