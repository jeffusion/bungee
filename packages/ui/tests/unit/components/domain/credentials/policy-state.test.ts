import { describe, expect, test } from 'bun:test';
import { applicationKeys, canEditPolicy, requestedKey, keyStatus, latestRequest, policyPayload, modelPatterns } from '../../../../../src/components/domain/credentials/policy-state';
import type { ApiKey, KeyExtension } from '../../../../../src/api/keys';
const key: ApiKey = { id: 'app', name: '开发', prefix: 'bg', createdAt: 1, expiresAt: null, revokedAt: null };
const extension: KeyExtension = { plugin: 'key-access', component: 'Test', path: '/keys/:keyId', active: true, ready: true, value: null };
const draft = { enabled: true, rps: 10, burst: 20, mode: 'monthly', limit: 1000 };
describe('凭证策略数据边界', () => {
  test('定位 API Key 与缺失 ID，允许已撤销 Key 只读定位', () => {
    const keys = [key, { ...key, id: 'old', revokedAt: 10 }];
    expect(applicationKeys(keys).map(key => key.id)).toEqual(['app', 'old']);
    expect(requestedKey('keyId=missing', keys)).toBe('');
    expect(requestedKey('keyId=old', keys)).toBe('old');
    expect(requestedKey('', keys)).toBe('app');
  });
  test('过期、撤销、未就绪、停用时都不可写', () => {
    expect(canEditPolicy(key, extension, 100)).toBe(true);
    for (const candidate of [{ ...key, expiresAt: 100 }, { ...key, revokedAt: 1 }]) expect(canEditPolicy(candidate, extension, 100)).toBe(false);
    for (const policy of [{ ...extension, active: false }, { ...extension, ready: false }, null]) expect(canEditPolicy(key, policy, 100)).toBe(false);
    expect(keyStatus({ ...key, expiresAt: 100 }, 100)).toBe('已过期');
  });
  test('晚到旧响应不覆盖当前 Key，卸载失效', async () => {
    const guard = latestRequest(); let visible = ''; let finishOld!: () => void;
    const old = guard.begin();
    const request = new Promise<void>(resolve => finishOld = resolve).then(() => { if (guard.current(old)) visible = 'old'; });
    const current = guard.begin(); if (guard.current(current)) visible = 'current';
    finishOld(); await request; expect(visible).toBe('current');
    guard.invalidate(); expect(guard.current(current)).toBe(false);
  });
  test('空范围代表全部，模型保留精确大小写并去重，关闭策略写 null', () => {
    expect(modelPatterns(' GPT-4.1\n\nGPT-4.1\ngpt-4.1 ')).toEqual(['GPT-4.1', 'gpt-4.1']);
    expect(policyPayload('budget', { ...draft, enabled: false })).toBe(null);
  });
  test('限速与额度拒绝无效或非整数输入', () => {
    expect(() => policyPayload('rate', { ...draft, rps: 0 })).toThrow();
    expect(() => policyPayload('rate', { ...draft, burst: 1.5 })).toThrow();
    expect(() => policyPayload('budget', { ...draft, limit: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(policyPayload('budget', draft)).toEqual({ mode: 'monthly', limit: 1000 });
  });
});
