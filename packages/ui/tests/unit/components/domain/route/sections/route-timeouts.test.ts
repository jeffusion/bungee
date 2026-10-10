import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { DEFAULT_REQUEST_MS, setFirstResponseMs, setRequestMs } from '$utils/route-timeouts';
import { validateRoute } from '$validation/route-validator';
import type { Route } from '$api/routes';

const source = await Bun.file(new URL('../../../../../../src/components/domain/route/sections/BasicInfoSection.svelte', import.meta.url)).text();
const editor = await Bun.file(new URL('../../../../../../src/routes/RouteEditor.svelte', import.meta.url)).text();
const serviceEditor = await Bun.file(new URL('../../../../../../src/routes/ServiceEditor.svelte', import.meta.url)).text();

function route(timeouts?: Route['timeouts'], service?: string): Route {
  return { path: '/codex/', ...(service ? { service } : { endpoints: [{ target: 'https://example.test' }] }), timeouts };
}

test('first-response input raises request budget, including when the request field is empty', async () => {
  for (const service of [undefined, 'openai-pool']) {
    const current = route({ request_ms: 600_000 }, service);
    current.timeouts = setFirstResponseMs(current.timeouts, 700_000);
    expect(current.timeouts).toEqual({ request_ms: 700_000, first_response_ms: 700_000 });
    const withDefault = route(undefined, service);
    withDefault.timeouts = setFirstResponseMs(withDefault.timeouts, DEFAULT_REQUEST_MS + 1);
    expect(withDefault.timeouts).toEqual({ request_ms: DEFAULT_REQUEST_MS + 1, first_response_ms: DEFAULT_REQUEST_MS + 1 });
  }
});

test('lowering request below first-response shows a validation error and must block saving', async () => {
  for (const service of [undefined, 'openai-pool']) {
    const current = route({ request_ms: 700_000, first_response_ms: 700_000 }, service);
    const services = service ? [{ name: service, endpoints: [{ target: 'https://example.test' }] }] : [];
    current.timeouts = setRequestMs(current.timeouts, 600_000);
    expect((await validateRoute(current, services)).map((error) => error.field)).toContain('timeouts.request_ms');
    current.timeouts = setRequestMs(current.timeouts, undefined);
    expect((await validateRoute(current, services)).map((error) => error.field)).toContain('timeouts.request_ms');
  }
  expect(editor).toContain('await performValidation();');
  expect(editor).toContain('if (!isValid) {');
  expect(editor).toContain("error.field.startsWith('timeouts.')");
});

test('empty first-response removes extra deadline, including when both fields are blank', async () => {
  const current = route({ request_ms: 600_000, first_response_ms: 400_000 });
  current.timeouts = setFirstResponseMs(current.timeouts, undefined);
  expect(current.timeouts).toEqual({ request_ms: 600_000 });
  current.timeouts = setRequestMs(current.timeouts, undefined);
  expect(current.timeouts).toBeUndefined();
  expect((await validateRoute(current)).filter((error) => error.field.startsWith('timeouts.'))).toEqual([]);
  expect((await validateRoute(route({ first_response_ms: 100 }))).map((error) => error.field)).not.toContain('timeouts.request_ms');
});

test('only route forwarding policy offers both timeout inputs for direct and service-backed routes', () => {
  expect(compile(source, { filename: 'BasicInfoSection.svelte' }).warnings).toEqual([]);
  expect(source).toContain('oninput={updateFirstResponseMs}');
  expect(source).toContain('oninput={updateRequestMs}');
  const forward = editor.split("{:else if activeSection === 'forward'}")[1]?.split("{:else if activeSection === 'processing'}")[0];
  expect(forward).toContain('<BasicInfoSection bind:route {errors} showOnly="timeouts" />');
  expect(forward).toContain('<RetrySection bind:route />');
  expect(serviceEditor).not.toContain('TimeoutsSection');
  expect(source).not.toContain('route.service');
});

test('both locales explain that empty first-response has no additional limit, never a hidden 5s default', async () => {
  for (const locale of ['zh-CN', 'en']) {
    const messages = await Bun.file(new URL(`../../../../../../src/i18n/locales/${locale}.json`, import.meta.url)).json();
    expect(messages.routeEditor.firstResponseMsHelp).toMatch(locale === 'zh-CN' ? /留空不额外设限/ : /Leave blank for no additional/);
    expect(messages.routeEditor.firstResponseMsHelp).not.toMatch(/5000|5 秒|5s/);
    expect(messages.serviceEditor.timeouts).toBeUndefined();
  }
});
