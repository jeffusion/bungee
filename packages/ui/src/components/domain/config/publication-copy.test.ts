import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import zh from '../../../i18n/locales/zh-CN.json';
import en from '../../../i18n/locales/en.json';

test('generic finalization status does not guess handoff, request drain or cleanup phase', () => {
  expect(zh.configurationSave.draining).toContain('旧进程收尾尚未完成');
  expect(zh.configurationSave.drainFailed).toContain('旧进程收尾出现异常');
  expect(en.configurationSave.draining).toContain('old worker finalization is not yet complete');
  expect(en.configurationSave.drainFailed).toContain('old worker finalization encountered an error');
  expect(zh.configurationSave.drainUnconfirmed).not.toContain('已生效');
  expect(en.configurationSave.drainUnconfirmed).not.toContain('is effective');
  expect(zh.configurationSave.draining).not.toContain('旧请求正在结束');
  expect(en.configurationSave.draining).not.toContain('old requests are finishing');
});

test('handoff and natural draining share the configured value, not a deadline or fourth setting', () => {
  expect(zh.settings.publication.scope).toContain('响应头或失败');
  expect(en.settings.publication.scope).toContain('response headers or failure');
  expect(zh.settings.publication.drain_timeout_ms.help).toContain('独立计时且不续期');
  expect(en.settings.publication.drain_timeout_ms.help).toContain('two independent deadlines that are never extended');
  expect(zh.settings.publication.drain_start_timeout_ms.help).toContain('前置请求交接结束后');
  expect(en.settings.publication.drain_start_timeout_ms.help).toContain('After request handoff');
  for (const locale of [zh, en]) {
    const fields = Object.keys(locale.settings.publication).filter(key => key.endsWith('_timeout_ms'));
    expect(fields).toEqual(['drain_start_timeout_ms', 'drain_timeout_ms', 'worker_exit_timeout_ms']);
    expect(JSON.stringify(locale.settings.publication)).not.toMatch(/H\s*\+\s*C|total publication timeout|整次总超时/);
  }
});

test('cleanup and exit share one remaining budget and separate confirmation', () => {
  expect(zh.settings.publication.worker_exit_timeout_ms.help).toContain('起只计一次');
  expect(zh.settings.publication.worker_exit_timeout_ms.help).toContain('共用剩余时间');
  expect(zh.settings.publication.worker_exit_timeout_ms.help).toContain('分别核验');
  expect(en.settings.publication.worker_exit_timeout_ms.help).toContain('Starts once');
  expect(en.settings.publication.worker_exit_timeout_ms.help).toContain('share the remaining time');
  expect(en.settings.publication.worker_exit_timeout_ms.help).toContain('verified separately');
  expect(zh.settings.operationStages).toContain('前置请求交接');
  expect(en.settings.operationStages).toContain('Request handoff');
});

test('integration fixture uses finite SSE and binds its newly created service ID', () => {
  const source = readFileSync(new URL('../../../../tests/publication-draining.browser.ts', import.meta.url), 'utf8');
  expect(source).toContain("'Content-Type': 'text/event-stream'");
  expect(source).toContain("'data: [DONE]\\n\\n'");
  expect(source).toContain('setTimeout(() => finishStream(controller), maximumStreamMs)');
  expect(source).toContain('const serviceId = crypto.randomUUID()');
  expect(source).toContain('service_id: serviceId');
  expect(source).not.toContain('services[0].id');
  expect(source).not.toContain("'Content-Type': 'text/plain'");
  expect(source).not.toMatch(/page\.route\(|route\.fulfill\(|\/retry/);
});
