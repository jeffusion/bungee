import { expect, test } from 'bun:test';
import { formatLastUsed } from '../../../../../src/api/runtime-presentation';
import { runtimeStatus, runtimeAvailabilityKey } from '../../../../../src/api/runtime';
import { runtimeRecord, runtimeResponse, unavailableRuntime } from '../../../../helpers/runtime';
import en from '../../../../../src/i18n/locales/en.json';
import zh from '../../../../../src/i18n/locales/zh-CN.json';

const now = Date.UTC(2026, 0, 1);
for (const translations of [en, zh]) {
  const translate = (key: string) => key.split('.').reduce((value: any, part) => value[part], translations);
  test(`${translations === en ? 'English' : 'Chinese'} runtime labels and missing observations remain meaningful`, () => {
    for (const key of [...Object.values(runtimeStatus).map(state => state.key), runtimeAvailabilityKey(unavailableRuntime())]) {
      const label = translate(key);
      expect(typeof label).toBe('string');
      expect(label).not.toMatch(/no_fresh_active_admission|snapshot_unavailable|^MIXED$|^UNKNOWN$/);
    }
    const format = (runtime: Parameters<typeof formatLastUsed>[0]) => formatLastUsed(runtime, 'service', 'endpoint-id', translate, now);
    expect(format(runtimeResponse())).toBe(translations.services.noUsageRecord);
    expect(format(unavailableRuntime())).toBe(translations.runtime.unavailable);
    expect(format(null)).toBe(translations.runtime.unavailable);
    expect(format(runtimeResponse([runtimeRecord('UNKNOWN', { last_used_complete: false })]))).toBe(translations.runtime.unavailable);
    expect(format(runtimeResponse([runtimeRecord('UNKNOWN', { last_used_time: now, last_used_complete: false })])))
      .toBe(`${translations.runtime.observedOnly} · ${translations.services.justNow}`);
    expect(format(runtimeResponse([runtimeRecord('HEALTHY', { last_used_time: 0 })]))).not.toBe(translations.services.noUsageRecord);
  });
}
