import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { findRuntimeUpstream, runtimeStatus, runtimeAvailabilityKey, type RuntimeUpstreamsResponse } from '../../../api/runtime';
import { runtimeRecord, runtimeResponse, unavailableRuntime } from '../../../../tests/fixtures/runtime';
import en from '../../../i18n/locales/en.json';
import zh from '../../../i18n/locales/zh-CN.json';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('runtime badge compiles; unknown and mixed use readable bilingual status text', () => {
  const source = read('./RuntimeStatus.svelte');
  expect(compile(source, { filename: 'RuntimeStatus.svelte' }).warnings).toEqual([]);
  expect(source).toContain("record?.circuit_state ?? 'UNKNOWN'");
  expect(source).toContain('variant={upstream.is_disabled ?');
  expect(source).toContain('{#if !$isLoading}');
  const keys = [...Object.values(runtimeStatus).map(state => state.key), runtimeAvailabilityKey(unavailableRuntime())];
  for (const translations of [en, zh]) {
    for (const key of keys) {
      const label = key.split('.').reduce((value: any, part) => value[part], translations);
      expect(typeof label).toBe('string');
      expect(label).not.toMatch(/no_fresh_active_admission|snapshot_unavailable|^MIXED$|^UNKNOWN$/);
    }
  }
});

test('Services formats complete, partial, absent and zero timestamps without claiming missing observations are unused', () => {
  const source = read('../../../routes/ServicesIndex.svelte');
  const formatter = source.match(/  function formatLastUsed\([\s\S]*?\n  }/)![0];
  const build = new Function('findRuntimeUpstream', '$runtimeUpstreams', '$_', new Bun.Transpiler({ loader: 'ts' }).transformSync(`${formatter}; return formatLastUsed;`));
  for (const translations of [en, zh]) {
    const translate = (key: string) => key.split('.').reduce((value: any, part) => value[part], translations);
    const format = (runtime: RuntimeUpstreamsResponse | null) => build(findRuntimeUpstream, runtime, translate)('service', 'endpoint-id');
    expect(format(runtimeResponse())).toBe(translations.services.noUsageRecord);
    expect(format(unavailableRuntime())).toBe(translations.runtime.unavailable);
    expect(format(null)).toBe(translations.runtime.unavailable);
    expect(format(runtimeResponse([runtimeRecord('UNKNOWN', { last_used_complete: false })]))).toBe(translations.runtime.unavailable);
    expect(format(runtimeResponse([runtimeRecord('UNKNOWN', { last_used_time: Date.now(), last_used_complete: false })])))
      .toBe(`${translations.runtime.observedOnly} · ${translations.services.justNow}`);
    expect(format(runtimeResponse([runtimeRecord('HEALTHY', { last_used_time: 0 })]))).not.toBe(translations.services.noUsageRecord);
  }
  expect(source).toContain("record?.active_request_count ?? $_('runtime.unavailable')");
  expect(source).toContain('<RuntimeStatus stateKey={selectedServiceForEndpoints.name} {upstream} />');
  expect(source).not.toContain('if (!open) selectedServiceForEndpoints = null');
});
