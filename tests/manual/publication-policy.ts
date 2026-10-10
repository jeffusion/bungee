import { chromium, type Page } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashConfigurationContent } from '../../packages/core/src/config-storage/content-hash';

// Real disposable Core management API, never intercepted or replaced with fixtures.
const base = process.env.PUBLICATION_UI_URL ?? 'http://127.0.0.1:28287';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'only disposable local services are permitted');
const evidence = resolve(process.env.PUBLICATION_EVIDENCE_ROOT ?? "/tmp/bungee-publication", 'ui-browser');
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const results: object[] = [];
const fields = ['drain_start_timeout_ms', 'drain_timeout_ms', 'worker_exit_timeout_ms'];
const defaults = ['5', '300', '10'];
const matrix = [['desktop', 1440, 'zh-CN'], ['mobile', 390, 'zh-CN'], ['mobile-en', 390, 'en'], ['desktop-en', 1440, 'en']] as const;
const snapshot = async () => {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  return await response.json();
};
const before = await snapshot();
const instanceProof = process.argv.find(arg => arg.startsWith('--instance-proof='))?.slice('--instance-proof='.length);
let restorationReceipt: string | null = null;
async function verifyInstance(proof: string) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'publication-draining.ts'), '--verify-instance', `--instance-proof=${proof}`],
    { cwd: resolve(import.meta.dir, '../..'), env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text(), failure = await new Response(child.stderr).text();
  assert.equal(await child.exited, 0, failure); return JSON.parse(output).ownership;
}
if (process.env.PUBLICATION_UI_SAVE === '1') assert.ok(instanceProof, 'fail closed: real save requires an explicit owned local-server worker artifact');
assert.equal(before.config.logical_configuration.publication, undefined, 'start with a real legacy-absence configuration');
const shot = async (page: Page, name: string) => {
  const fullPage = await page.getByRole('dialog').count() === 0 && await page.getByTestId('settings-change-bar').count() === 0;
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  return page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage, animations: 'disabled' });
};
try {
  for (const [name, width, locale] of matrix) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    // Form acceptance must not depend on an external font service being online.
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
    await context.addInitScript(language => localStorage.setItem('locale', language), locale);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${name}: console: ${message.text()}`); });
    page.on('requestfailed', request => errors.push(`${name}: network: ${request.url()} ${request.failure()?.errorText}`));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${name}: HTTP ${response.status()}: ${response.url()}`); });
    let writes = 0, copyWrites = 0;
    page.on('request', request => {
      if (['PUT', 'POST', 'DELETE'].includes(request.method())) copyWrites++;
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/config') writes++;
    });
    await page.goto(`${base}/#/config`);
    await page.locator('#config-drain_timeout_ms').waitFor();
    await page.getByTestId('settings-serving-state').getByText(`r${before.revision}`, { exact: false }).waitFor();
    const overflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal overflow`);
    await overflow();
    assert.equal(await page.getByTestId('settings-change-bar').count(), 0);
    for (let i = 0; i < fields.length; i++) {
      const input = page.locator(`#config-${fields[i]}`);
      assert.equal(await input.inputValue(), defaults[i]);
      assert.equal(await input.getAttribute('aria-invalid'), 'false');
      const height = await input.evaluate(el => el.getBoundingClientRect().height);
      assert.equal(height, width === 390 ? 44 : 40);
    }
    const panel = page.locator('#settings-publication'), copy = await panel.innerText();
    assert.ok(copy.includes(locale === 'zh-CN' ? '响应头或失败' : 'response headers or failure'));
    assert.ok(copy.includes(locale === 'zh-CN' ? '独立计时且不续期' : 'two independent deadlines that are never extended'));
    assert.ok(copy.includes(locale === 'zh-CN' ? '清理完成与进程退出分别核验' : 'Cleanup completion and process exit are verified separately'));
    assert.equal(await panel.locator('input').count(), 3);
    assert.equal(copyWrites, 0, 'copy/layout checks must not mutate the service');
    await page.locator('#settings-publication').scrollIntoViewIfNeeded();
    await shot(page, `${name}-initial`);
    await page.locator('#config-drain_start_timeout_ms').focus();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('config-drain_start_timeout_ms')!).borderColor === 'rgb(249, 115, 22)');
    assert.equal(await page.locator('#config-drain_start_timeout_ms').evaluate(el => getComputedStyle(el).borderColor), 'rgb(249, 115, 22)');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'config-drain_timeout_ms');
    await shot(page, `${name}-keyboard-focus`);
    const invalidResults: object[] = [];
    for (let i = 0; i < fields.length; i++) {
      const input = page.locator(`#config-${fields[i]}`);
      for (const value of ['', '0', '-1', '1.5', '2147484']) {
        await input.fill(value);
        assert.equal(await input.inputValue(), value, 'do not clamp or rewrite invalid input');
        assert.equal(await input.getAttribute('aria-invalid'), 'true');
        assert.ok((await input.getAttribute('aria-describedby'))?.includes(`config-${fields[i]}-error`));
        assert.equal(await page.getByTestId('config-save-button').isDisabled(), true);
        assert.equal(await page.getByTestId('settings-change-bar').getByRole('button').first().isEnabled(), true);
        await overflow();
        invalidResults.push({ field: fields[i], value, retained: true, reviewDisabled: true, discardEnabled: true });
      }
      await input.fill(defaults[i]);
    }
    // Boundary and relationship checks: editing one timeout must not modify another.
    await page.locator('#config-drain_start_timeout_ms').fill('2147483');
    assert.equal(await page.locator('#config-drain_timeout_ms').inputValue(), '300');
    assert.equal(await page.locator('#config-worker_exit_timeout_ms').inputValue(), '10');
    await page.locator('#config-drain_timeout_ms').fill('1');
    assert.equal(await page.locator('#config-drain_start_timeout_ms').inputValue(), '2147483');
    assert.equal(await page.locator('#config-worker_exit_timeout_ms').inputValue(), '10');
    await page.locator('#config-worker_exit_timeout_ms').fill('2147483');
    assert.equal(await page.locator('#config-drain_start_timeout_ms').inputValue(), '2147483');
    assert.equal(await page.locator('#config-drain_timeout_ms').inputValue(), '1');
    assert.equal(await page.locator('#settings-publication [aria-invalid="true"]').count(), 0);
    assert.equal(await page.getByTestId('config-save-button').isEnabled(), true);
    await page.getByTestId('config-save-button').click();
    await page.getByTestId('config-confirm-publish').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !(document.querySelector('[data-testid="config-confirm-publish"]') as HTMLButtonElement)?.disabled);
    const diff = await page.getByTestId('config-diff').innerText();
    assert.ok(diff.includes('2147483')); assert.ok(diff.includes('300')); assert.ok(diff.includes('10'));
    assert.ok(diff.includes(locale === 'zh-CN' ? '未显式设置' : 'not explicitly set'));
    assert.equal(await page.getByTestId('config-diff').locator('li').count(), 3);
    await overflow(); await shot(page, `${name}-review-independent-max`);
    await page.getByRole('button', { name: locale === 'zh-CN' ? '关闭审阅' : 'Close review', exact: true }).click();
    await page.getByTestId('config-review').waitFor({ state: 'hidden' });
    for (const field of fields) await page.locator(`#config-${field}`).fill('10');
    assert.equal(await page.locator('#settings-publication [aria-invalid="true"]').count(), 0);
    await page.getByTestId('config-save-button').click();
    await page.waitForFunction(() => !(document.querySelector('[data-testid="config-confirm-publish"]') as HTMLButtonElement)?.disabled);
    await shot(page, `${name}-review-equal-timers`);
    await page.getByRole('button', { name: locale === 'zh-CN' ? '关闭审阅' : 'Close review', exact: true }).click();
    await page.getByTestId('config-review').waitFor({ state: 'hidden' });
    // Very long intermediate text is retained without spilling out of the field.
    await page.locator('#config-drain_timeout_ms').fill('9'.repeat(200));
    assert.equal((await page.locator('#config-drain_timeout_ms').inputValue()).length, 200);
    assert.equal(await page.getByTestId('config-save-button').isDisabled(), true);
    await shot(page, `${name}-invalid-long`); await overflow();
    // In-app navigation must protect an invalid draft, even when no valid policy exists.
    if (width === 390) {
      // Shell uses a mobile menu rather than the desktop nav.
      const menu = page.getByRole('button', { name: /菜单|menu/i });
      if (await menu.count()) await menu.first().click();
    }
    await page.locator('a[href="/#/routes"]:visible').first().click();
    const leaveDialog = page.getByRole('dialog').filter({ has: page.getByTestId('confirmation-cancel') });
    await leaveDialog.waitFor();
    assert.match(await leaveDialog.innerText(), locale === 'zh-CN' ? /离开全局设置/ : /leave global settings/i);
    await shot(page, `${name}-invalid-leave`);
    await page.getByTestId('confirmation-cancel').click();
    if (width === 390) await page.keyboard.press('Escape');
    assert.equal(await page.locator('#config-drain_timeout_ms').inputValue(), '9'.repeat(200));
    // A valid import owns its candidate validation; cancelling restores the invalid local text.
    const exported = await (await fetch(`${base}/api/config/export`)).json();
    exported.aggregate.logical_configuration.publication = { drain_start_timeout_ms: 6000, drain_timeout_ms: 301000, worker_exit_timeout_ms: 11000 };
    exported.content_hash = hashConfigurationContent(exported.aggregate);
    const { envelope_hash: _oldHash, ...envelope } = exported;
    exported.envelope_hash = hashConfigurationContent(envelope);
    await page.getByTestId('config-import-input').setInputFiles({ name: 'valid-policy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await page.getByTestId('import-preview').waitFor();
    assert.equal(await page.locator('#config-drain_timeout_ms').inputValue(), '301');
    assert.equal(await page.locator('#config-drain_timeout_ms').getAttribute('aria-invalid'), 'false');
    assert.equal(await page.getByTestId('config-save-button').isEnabled(), true);
    await page.getByTestId('config-save-button').click();
    await page.waitForFunction(() => !(document.querySelector('[data-testid="config-confirm-publish"]') as HTMLButtonElement)?.disabled);
    await page.getByRole('button', { name: locale === 'zh-CN' ? '关闭审阅' : 'Close review', exact: true }).click();
    await page.getByTestId('config-review').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: locale === 'zh-CN' ? '取消导入' : 'Cancel import', exact: true }).click();
    assert.equal(await page.locator('#config-drain_timeout_ms').inputValue(), '9'.repeat(200));
    assert.equal(await page.getByTestId('config-save-button').isDisabled(), true);
    await page.getByTestId('settings-change-bar').getByRole('button', { name: locale === 'zh-CN' ? '放弃更改' : 'Discard changes', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: locale === 'zh-CN' ? '放弃更改' : 'Discard changes', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="settings-change-bar"]'));
    for (let i = 0; i < fields.length; i++) assert.equal(await page.locator(`#config-${fields[i]}`).inputValue(), defaults[i]);
    assert.equal(writes, 0, 'pure form acceptance must not write configuration');
    await shot(page, `${name}-discarded`);
    results.push({ name, width, locale, initialAbsence: true, phaseHelpPresent: true, copyWrites: 0, invalidResults, focus: true, relationshipAccepted: true, equalTimersAccepted: true, siblingValuesUnchanged: true, diffUnits: true, leaveProtected: true, discarded: true, writes });
    await context.close();
  }
  const afterForms = await snapshot();
  assert.equal(afterForms.revision, before.revision); assert.deepEqual(afterForms.config, before.config);
  const design = await browser.newPage();
  await design.goto(`${base}/#/design`); await design.getByText('Design System', { exact: true }).waitFor();
  await shot(design, 'design-reference'); await design.close();
  // The validation owner runs forms by default. The orchestrator explicitly
  // enables the real save integration after all runtime writers are finished.
  if (process.env.PUBLICATION_UI_SAVE === '1') {
  // Persist all three fields through the actual product review and save API.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`persist: ${error.message}`));
  await page.goto(`${base}/#/config`); await page.locator('#config-drain_timeout_ms').waitFor();
  const submitted = ['6', '301', '11'];
  for (let i = 0; i < fields.length; i++) await page.locator(`#config-${fields[i]}`).fill(submitted[i]);
  await page.getByTestId('config-save-button').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="config-confirm-publish"]') as HTMLButtonElement)?.disabled);
  await shot(page, 'persist-review');
  const put = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config' && response.request().method() === 'PUT');
  const owned = await verifyInstance(instanceProof!);
  await page.getByTestId('config-confirm-publish').click();
  const savedResponse = await put;
  assert.equal(savedResponse.status(), 202); const accepted = await savedResponse.json();
  await page.waitForFunction(() => !document.querySelector('[data-testid="config-review"]'), undefined, { timeout: 30000 });
  await page.reload(); await page.locator('#config-drain_timeout_ms').waitFor();
  for (let i = 0; i < fields.length; i++) assert.equal(await page.locator(`#config-${fields[i]}`).inputValue(), submitted[i]);
  assert.equal(await page.getByTestId('settings-change-bar').count(), 0);
  const persisted = await snapshot();
  assert.deepEqual(persisted.config.logical_configuration.publication, { drain_start_timeout_ms: 6000, drain_timeout_ms: 301000, worker_exit_timeout_ms: 11000 });
  assert.equal(persisted.revision, before.revision + 1);
  await shot(page, 'persist-populated');
  results.push({ name: 'real-persistence', accepted, revision: persisted.revision, policy: persisted.config.logical_configuration.publication });
  await context.close();
  // Produce a NEW isolated failure through the real stream/publication flow.
  // Never borrow a pre-existing degraded operation or replace API responses.
  const savedRuntime = await (await fetch(`${base}/api/config/runtime`)).json();
  const currentProof = resolve(owned.state, 'runtime/workers', `${savedRuntime.workers[0].worker_instance_id}.json`);
  await verifyInstance(currentProof);
  const setup = Bun.spawn([process.execPath, resolve(import.meta.dir, 'publication-draining.ts'), '--degraded', '--defer-restore', `--instance-proof=${currentProof}`], {
    cwd: resolve(import.meta.dir, '../..'), env: process.env,
    stdout: Bun.file(resolve(evidence, 'degraded-setup.log')), stderr: Bun.file(resolve(evidence, 'degraded-setup.stderr.log')),
  });
  const setupExit = await setup.exited;
  const receiptFile = resolve(process.env.PUBLICATION_EVIDENCE_ROOT ?? "/tmp/bungee-publication", 'ui-draining-browser/restore-receipt.json');
  if (await Bun.file(receiptFile).exists()) {
    restorationReceipt = receiptFile;
    const receipt = await Bun.file(receiptFile).json();
    // The policy suite owns its earlier save too; restore the actual initial
    // aggregate only after the same produced operation passes status checks.
    receipt.originalConfig = before.config;
    await Bun.write(receiptFile, JSON.stringify(receipt, null, 2));
  }
  assert.equal(setupExit, 0, 'real D-cutoff setup must complete before status assertions');
  const produced = JSON.parse(await Bun.file(resolve(process.env.PUBLICATION_EVIDENCE_ROOT ?? "/tmp/bungee-publication", 'ui-draining-browser/results.json')).text());
  const terminal = produced.results.find((item: any) => item.stage === 'final-terminal')?.terminal;
  assert.equal(terminal.operation.state, 'degraded');
  assert.equal(terminal.operation.error_code, 'old_worker_drain_failed');
  const runtime = await (await fetch(`${base}/api/config/runtime`)).json();
  assert.equal(runtime.publication.operation.operation_id, terminal.operation.mutation_id);
  assert.equal(runtime.publication.operation.error_code, 'old_worker_drain_failed');
  assert.equal(runtime.publication.serving_complete, true);
  assert.equal(runtime.publication.serving_revision, runtime.publication.target_revision);
  const operation = await (await fetch(`${base}/api/config/operations/${terminal.operation.mutation_id}`)).json();
  const envelope = await (await fetch(`${base}/api/config/export`)).json();
  for (const [name, width, locale] of matrix) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(language => localStorage.setItem('locale', language), locale);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(`${name}-status: ${error.message}`));
    let writes = 0; page.on('request', request => { if (request.method() === 'PUT') writes++; });
    await page.goto(`${base}/#/config`); await page.locator('#config-drain_timeout_ms').waitFor();
    const banner = page.getByTestId('configuration-publication-banner'); await banner.waitFor();
    const statusCopy = locale === 'zh-CN' ? /新配置已生效，旧进程收尾出现异常/ : /New configuration is effective; old worker finalization encountered an error/;
    assert.match(await banner.innerText(), statusCopy);
    await page.getByTestId('settings-publication-state').getByRole('button').click();
    const details = page.getByTestId('publication-details'); await details.waitFor();
    await page.waitForFunction(() => /收尾操作失败|finalization failed|收尾确认超时|finalization confirmation timed out|退出尚未确认|exit not confirmed|提前退出|exited early|确认消息无效|Invalid old worker|确认身份不匹配|identity mismatch/.test(document.querySelector('[data-testid="publication-details"]')?.textContent ?? ''));
    assert.ok(operation.operation.error_detail, 'the actual failure detail must be retained');
    assert.equal(await page.getByTestId('publication-retry-button').count(), 0);
    await details.scrollIntoViewIfNeeded(); await shot(page, `${name}-historical-drain-details`);
    const negative = structuredClone(envelope); negative.aggregate.logical_configuration.publication.drain_timeout_ms = 0;
    await page.getByTestId('config-import-input').setInputFiles({ name: 'invalid-publication-export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(negative)) });
    await page.getByTestId('import-preview').waitFor(); assert.equal(await page.locator('#config-drain_timeout_ms').inputValue(), '0');
    const validation = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/validate' && response.request().method() === 'POST');
    await page.getByTestId('config-save-button').click(); const rejected = await (await validation).json(); assert.equal(rejected.valid, false);
    await page.waitForFunction(() => document.getElementById('config-drain_timeout_ms')?.getAttribute('aria-invalid') === 'true');
    assert.equal(await page.getByTestId('config-confirm-publish').isDisabled(), true);
    await page.getByRole('button', { name: locale === 'zh-CN' ? '关闭审阅' : 'Close review', exact: true }).click(); await page.getByTestId('config-review').waitFor({ state: 'hidden' });
    assert.ok((await page.locator('#config-drain_timeout_ms').getAttribute('aria-describedby'))?.includes('config-drain_timeout_ms-error'));
    assert.ok(await page.locator('#config-drain_timeout_ms-error').isVisible());
    await page.locator('#settings-publication').scrollIntoViewIfNeeded(); await shot(page, `${name}-server-field-error`);
    await page.getByRole('button', { name: locale === 'zh-CN' ? '取消导入' : 'Cancel import', exact: true }).click();
    assert.equal(await page.locator('#config-drain_timeout_ms').getAttribute('aria-invalid'), 'false'); assert.equal(await page.getByTestId('settings-change-bar').count(), 0);
    await page.goto(`${base}/#/`); await banner.waitFor(); assert.match(await banner.innerText(), statusCopy);
    assert.equal(await page.getByTestId('publication-retry-button').count(), 0); await shot(page, `${name}-dashboard`);
    await page.goto(`${base}/#/config`); await page.locator('#config-drain_timeout_ms').waitFor(); await banner.waitFor();
    await context.setOffline(true);
    await page.waitForFunction(() => !/已生效|is effective/.test(document.querySelector('[data-testid="configuration-publication-banner"]')?.textContent ?? ''), undefined, { timeout: 12000 });
    assert.match(await page.getByTestId('settings-serving-state').innerText(), locale === 'zh-CN' ? /未知|过期/ : /unknown|stale/i);
    await shot(page, `${name}-offline-unknown`); await context.setOffline(false); assert.equal(writes, 0);
    results.push({ name: `${name}-status`, width, locale, producedOperation: terminal.operation.mutation_id, historicalDrainDetail: operation.operation.error_detail,
      targetServing: runtime.publication.serving_revision, backendValidation: rejected, dashboardConsistent: true, staleDoesNotClaimEffective: true, writes });
    await context.close();
  }
  }
} finally {
  await browser.close();
  if (restorationReceipt) {
    const restore = Bun.spawn([process.execPath, resolve(import.meta.dir, 'publication-draining.ts'), `--restore=${restorationReceipt}`], {
      cwd: resolve(import.meta.dir, '../..'), env: process.env,
      stdout: Bun.file(resolve(evidence, 'restore.log')), stderr: Bun.file(resolve(evidence, 'restore.stderr.log')),
    });
    if (await restore.exited !== 0) errors.push('CAS restoration refused or failed; isolated receipt retained for the orchestrator');
  }
  writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ base, service: 'real-isolated-core', results, errors }, null, 2));
}
assert.deepEqual(errors, []);
console.log(JSON.stringify({ base, service: 'real-isolated-core', results, errors, evidence }, null, 2));
