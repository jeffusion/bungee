import type { PublicationRetirement } from '../config-storage/retirement-store';

export type ConfigControlRuntimeHealth = Readonly<{
  observed_at: number;
  component_recovery: readonly Readonly<{
    component: 'ingress' | 'config_storage' | 'plugin_state';
    state: 'healthy' | 'recovering' | 'stopped' | 'unknown';
    reason_code: string | null;
    attempt_count: number | null;
    max_attempts: number | null;
    next_retry_at: number | null;
  }>[];
  dependencies: readonly Readonly<{
    component: string;
    state: 'ready' | 'unavailable' | 'stopped';
    fresh: boolean;
    observed_at: number | null;
  }>[];
}>;

/** Only public health facts cross the management boundary. */
export function runtimeHealthSnapshot(health: ConfigControlRuntimeHealth | null): ConfigControlRuntimeHealth | null {
  if (health === null) return null;
  return { observed_at: health.observed_at,
    component_recovery: health.component_recovery.map(item => ({ component: item.component, state: item.state,
      reason_code: item.reason_code, attempt_count: item.attempt_count, max_attempts: item.max_attempts, next_retry_at: item.next_retry_at })),
    dependencies: health.dependencies.map(item => ({ component: item.component, state: item.state, fresh: item.fresh, observed_at: item.observed_at })) };
}

export function publicationCleanup(retirement: PublicationRetirement | null,
  remaining?: (bootId: string, deadlineNs: string) => number | null) {
  if (retirement === null) return null;
  const members = retirement.members.map(member => {
    const evidence = retirement.evidence.find(item => item.member_id === member.identity.worker_instance_id);
    const deadline = evidence?.exit_deadline_ns ?? member.start_deadline_ns;
    const boot = evidence?.exit_boot_id ?? member.deadline_boot_id;
    const value = evidence?.exit_state === 'confirmed' || deadline===null ? null : remaining?.(boot, deadline) ?? null;
    return { slot: member.identity.worker_slot, exit_state: evidence?.exit_state ?? 'unknown',
      cleanup_state: evidence?.cleanup_state ?? 'unknown',
      remaining_ms: value !== null && Number.isFinite(value) && value >= 0 ? value : null };
  });
  const deadlines = members.filter(member => member.exit_state !== 'confirmed');
  return { active: retirement.state !== 'released', state: retirement.state, reason_code: retirement.reason_code,
    pending_count: members.filter(member => member.exit_state === 'live').length,
    exit_unknown_count: members.filter(member => member.exit_state === 'unknown').length,
    failed_count: members.filter(member => member.cleanup_state === 'failed').length,
    unknown_count: members.filter(member => member.cleanup_state === 'unknown').length,
    remaining_ms: deadlines.length && deadlines.every(member => member.remaining_ms !== null)
      ? Math.min(...deadlines.map(member => member.remaining_ms!)) : null,
    members };
}
