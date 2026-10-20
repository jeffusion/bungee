import { expect, test } from 'bun:test';
import { DEFAULT_REQUEST_MS, setFirstResponseMs, setRequestMs } from '$utils/route-timeouts';
import { validateRoute } from '$validation/route-validator';
import type { Route } from '$api/routes';

const editor = await Bun.file(new URL('../../../../../../src/routes/RouteEditor.svelte', import.meta.url)).text();

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
