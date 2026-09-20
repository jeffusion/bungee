import type { Database } from 'bun:sqlite';
import { ConfigRepositoryError } from '../config-storage/repository-types';
import { requireUuid, requireSafeInteger } from '../config-storage/persisted-validation';
import { sqliteAll } from '../config-storage/sqlite-query';
import { isLowercaseUuid } from '../config-storage/validation';

export type SupervisionState = {
  readonly instance_id: string;
  readonly controller_epoch: number;
  readonly current_controller_id: string | null;
  readonly updated_at: number;
};

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

type SupervisionStateRow = {
  readonly id: unknown;
  readonly instance_id: unknown;
  readonly controller_epoch: unknown;
  readonly current_controller_id: unknown;
  readonly updated_at: unknown;
};

function requireCommandUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !isLowercaseUuid(value)) {
    throw new ConfigRepositoryError('invalid_command', `${field} must be a lowercase UUID`);
  }
  return value;
}

function requireCommandTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_SAFE_INTEGER) {
    throw new ConfigRepositoryError('invalid_command', 'updated_at must be below Number.MAX_SAFE_INTEGER');
  }
  return value;
}

function readState(db: Database): SupervisionState {
  const rows = sqliteAll<SupervisionStateRow, []>(db, `
    SELECT id,instance_id,controller_epoch,current_controller_id,updated_at
    FROM supervision_state`);
  if (rows.length !== 1) {
    throw new ConfigRepositoryError('schema_corrupt', 'supervision state must contain exactly one row');
  }
  const row = rows[0];
  if (row === undefined || row.id !== 1 || typeof row.instance_id !== 'string' || typeof row.controller_epoch !== 'number'
    || (row.current_controller_id !== null && typeof row.current_controller_id !== 'string')
    || typeof row.updated_at !== 'number') {
    throw new ConfigRepositoryError('schema_corrupt', 'supervision state contains invalid persisted values');
  }
  const instanceId = requireUuid(row.instance_id, 'supervision_state.instance_id');
  const epoch = requireSafeInteger(row.controller_epoch, 'supervision_state.controller_epoch');
  if (epoch >= MAX_SAFE_INTEGER) {
    throw new ConfigRepositoryError('schema_corrupt', 'supervision_state.controller_epoch is out of range');
  }
  const updatedAt = requireSafeInteger(row.updated_at, 'supervision_state.updated_at');
  if (updatedAt >= MAX_SAFE_INTEGER) {
    throw new ConfigRepositoryError('schema_corrupt', 'supervision_state.updated_at is out of range');
  }
  const controllerId = row.current_controller_id === null
    ? null : requireUuid(row.current_controller_id, 'supervision_state.current_controller_id');
  return {
    instance_id: instanceId,
    controller_epoch: epoch,
    current_controller_id: controllerId,
    updated_at: updatedAt,
  };
}

export class SupervisionStateRepository {
  constructor(private readonly db: Database) {}

  get(): SupervisionState {
    return readState(this.db);
  }

  /** Caller must hold the master instance locks; lock ownership is outside this repository. */
  claim(controllerId: string, updatedAt: number): SupervisionState {
    const id = requireCommandUuid(controllerId, 'controller_id');
    const timestamp = requireCommandTimestamp(updatedAt);
    return this.db.transaction(() => {
      const state = readState(this.db);
      if (state.controller_epoch >= MAX_SAFE_INTEGER - 1) {
        throw new ConfigRepositoryError('repository_failure', 'supervision controller epoch is exhausted');
      }
      const effectiveUpdatedAt = Math.max(timestamp, state.updated_at);
      const result = this.db.run(`UPDATE supervision_state
        SET controller_epoch=controller_epoch+1,current_controller_id=?,updated_at=?`, [id, effectiveUpdatedAt]);
      if (result.changes !== 1) {
        throw new ConfigRepositoryError('schema_corrupt', 'supervision state singleton update failed');
      }
      return readState(this.db);
    }).immediate();
  }
}

export function readSupervisionState(db: Database): SupervisionState {
  return readState(db);
}
