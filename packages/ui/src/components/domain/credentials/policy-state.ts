import type { ApiKey, KeyExtension } from '../../../api/keys';

export type PolicyKind = 'rate' | 'budget';
export function keyStatus(key: ApiKey, now = Date.now()): '已撤销' | '已过期' | '有效' {
  return key.revokedAt != null ? '已撤销' : key.expiresAt != null && key.expiresAt <= now ? '已过期' : '有效';
}
export function applicationKeys(keys: ApiKey[]) { return keys; }
export function requestedKey(query: string, keys: ApiKey[]): string {
  const id = new URLSearchParams(query).get('keyId');
  return id ? applicationKeys(keys).find(key => key.id === id)?.id ?? '' : applicationKeys(keys)[0]?.id ?? '';
}
export function canEditPolicy(key: ApiKey | undefined, extension: KeyExtension | null, now = Date.now()): boolean {
  return !!key && keyStatus(key, now) === '有效' && !!extension?.active && !!extension.ready;
}
/** Each view owns this guard. An old response may never replace the selected Key's state. */
export function latestRequest() {
  let generation = 0;
  return { begin: () => ++generation, current: (token: number) => token === generation, invalidate: () => { generation++; } };
}
export function modelPatterns(text: string): string[] | null {
  const models = [...new Set(text.split('\n').map(value => value.trim()).filter(Boolean))];
  return models.length ? models : null;
}
export function policyPayload(kind: PolicyKind, draft: { enabled: boolean; rps: number; burst: number; mode: string; limit: number }): unknown {
  if (!draft.enabled) return null;
  if (kind === 'rate') {
    if (!Number.isFinite(draft.rps) || draft.rps <= 0 || !Number.isSafeInteger(draft.burst) || draft.burst < 1) throw new Error('每秒请求数必须大于 0，突发容量必须是正整数。');
    return { rps: draft.rps, burst: draft.burst };
  }
  if (!['monthly', 'cumulative'].includes(draft.mode) || !Number.isSafeInteger(draft.limit) || draft.limit < 1) throw new Error('Token 额度必须是正整数。');
  return { mode: draft.mode, limit: draft.limit };
}
