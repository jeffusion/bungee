import { test as browserTest } from 'bun:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { menuSnapshot, fulfillMenuIcons } from '../helpers/menus';
import { dashboardSample, historySample } from '../helpers/dashboard/stats';
import type { TimeRange } from '../../src/types';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';

browserTest('carousel', async () => {
const uiRuntime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/carousel.html'] });
let builtRuntime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let origin = uiRuntime.origin;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => errors.push(`Request failed: ${request.url()}`));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    // No external fonts or live management server are needed for acceptance.
    if (url.origin !== origin) {
      if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.fulfill({ contentType: url.hostname === 'fonts.googleapis.com' ? 'text/css' : 'text/plain', body: '' });
      errors.push(`Unexpected external resource: ${route.request().url()}`); return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (route.request().method() !== 'GET') throw new Error(`Unexpected method: ${route.request().method()} ${url.pathname}`);
    const reply = (json: unknown) => route.fulfill({ json });
    if (url.pathname === '/api/auth/mode') return reply({ mode: 'anonymous' });
    if (url.pathname === '/api/auth/verify') return reply({ success: true, mode: 'anonymous' });
    if (url.pathname === '/api/config/runtime') return reply(configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })));
    if (url.pathname === '/api/config') return reply({ revision: 1, content_hash: 'carousel-test', config: { logical_configuration: { auth: { enabled: false, tokens: [] }, routes: [], services: [], plugins: [] }, plugin_activations: [] } });
    if (url.pathname === '/api/stats/dashboard') return reply(dashboardSample((url.searchParams.get('range') ?? '1h') as TimeRange, Date.now(), historySample([])));
    if (url.pathname === '/api/runtime/upstreams') return reply({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
    if (['/api/plugins', '/api/services', '/api/routes'].includes(url.pathname)) return reply([]);
    if (url.pathname === '/api/plugin-translations') return reply({});
    if (url.pathname === '/api/ui/menus') return reply(menuSnapshot());
    if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
    throw new Error(`Unexpected API: ${url.pathname}`);
  });
  const clockStart = new Date('2026-10-04T00:00:00Z');
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart);
  await page.goto(`${origin}/tests/fixtures/carousel.html`);
  await page.getByRole('region', { name: 'Test carousel' }).waitFor();
  const carousel = page.getByRole('region', { name: 'Test carousel' });
  const viewport = carousel.locator('[id$="-viewport"]');
  const clickControl = async (name: string) => { await carousel.hover(); await carousel.getByRole('button', { name, exact: true }).click(); };
  const state = () => page.evaluate(() => (window as any).carouselTest.state());
  const configure = async (value: Record<string, unknown>) => {
    await page.evaluate(value => (window as any).carouselTest.configure(value), value);
    await page.evaluate(() => Promise.resolve());
  };
  const advance = async (ms = 1100) => { await page.clock.runFor(ms); };
  let assertion = 0;
  const expectIndex = async (index: number) => assert.equal((await state()).index, index, `Index assertion ${++assertion}`);
  const leave = async () => {
    await page.locator('#outside').focus();
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => !document.querySelector('[aria-roledescription="carousel"]')?.matches(':hover, :focus-within'));
    await page.evaluate(() => (window as any).carouselTest.settle());
  };

  const indicator = carousel.locator('[data-carousel-indicators]');
  assert.equal(await indicator.innerText(), '', 'indicators carry no visible numbers');
  assert.equal((await indicator.getByRole('button').first().boundingBox())!.width, 24, 'small marks have usable targets');
  assert.equal(await indicator.locator('span').first().evaluate(el => el.getBoundingClientRect().height), 3);
  assert.equal(await carousel.locator('.carousel-next').evaluate(el => getComputedStyle(el).opacity), '0', 'no arrows at rest');

  // No interval prop has been passed: exercise the component default.
  await advance(4999); await expectIndex(0);
  await advance(1); await expectIndex(1);
  await configure({ interval: 1000 });
  await advance(); await expectIndex(2);
  await advance(); await expectIndex(0);
  assert.deepEqual((await state()).changes, [1, 2, 0]);
  assert.equal(await carousel.locator('[aria-live]').innerText(), '', 'automatic updates are not announced');

  await viewport.hover(); await advance(3000); await expectIndex(0);
  await page.screenshot({ path: '/tmp/bungee-carousel-hover.png' });
  await page.mouse.move(0, 0); await advance(999); await expectIndex(0);
  await advance(1); await expectIndex(1);
  await viewport.focus(); await advance(2000); await expectIndex(1);
  await page.screenshot({ path: '/tmp/bungee-carousel-focus.png' });
  await viewport.press('ArrowRight'); await expectIndex(2);
  await viewport.press('ArrowRight'); await expectIndex(0);
  await viewport.press('End'); await expectIndex(2);
  await viewport.press('Home'); await expectIndex(0);
  await carousel.getByLabel('Alpha input').fill('Retained value');
  await carousel.getByLabel('Alpha input').press('ArrowRight'); await expectIndex(0);
  assert.equal(await carousel.locator('.carousel-next').evaluate(el => getComputedStyle(el).pointerEvents), 'auto', 'keyboard focus reveals contextual controls');
  await clickControl('Previous slide'); await expectIndex(2);
  assert.equal(await carousel.locator('[data-carousel-slide="0"]').getAttribute('inert'), '');
  await clickControl('Go to slide 1'); await expectIndex(0);
  assert.equal(await carousel.getByLabel('Alpha input').inputValue(), 'Retained value');
  assert.equal(await carousel.locator('[aria-live]').innerText(), 'Slide 1 of 3');

  await clickControl('Pause autoplay');
  await leave(); await advance(3000); await expectIndex(0);
  await clickControl('Start autoplay');
  await leave(); await advance(); await expectIndex(1);
  // Replacing the playback icon under the pointer must not latch hover-pause.
  for (let cycle = 0; cycle < 3; cycle++) {
    const selected = (await state()).index;
    await clickControl('Pause autoplay');
    await leave(); await advance(2500); await expectIndex(selected);
    await clickControl('Start autoplay');
    await leave(); await advance(); await expectIndex((selected + 1) % 3);
  }
  await configure({ index: 0 }); await advance(900); await expectIndex(0);
  await configure({ index: 2 }); await advance(999); await expectIndex(2);
  await advance(1); await expectIndex(0);

  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await advance(3000); await expectIndex(0);
  await page.evaluate(() => { delete (document as any).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await advance(); await expectIndex(1);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await advance(50);
  assert(await carousel.getByRole('button', { name: /disabled by reduced motion/ }).isDisabled());
  await advance(3000); await expectIndex(1);
  assert(await carousel.getByRole('button', { name: /disabled by reduced motion/ }).isDisabled());
  assert.equal(await carousel.locator('[data-carousel-slide="1"]').evaluate(el => getComputedStyle(el).transitionProperty), 'none');
  await clickControl('Next slide'); await expectIndex(2);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await configure({ autoplay: false, loop: false, index: 0 });
  await leave(); await advance(3000); await expectIndex(0);
  assert(await carousel.getByRole('button', { name: 'Previous slide', exact: true }).isDisabled());
  assert.equal(await carousel.getByRole('button', { name: /autoplay/ }).count(), 0);
  await viewport.focus(); await viewport.press('End'); await expectIndex(2);
  assert(await carousel.getByRole('button', { name: 'Next slide', exact: true }).isDisabled());
  await viewport.press('ArrowRight'); await expectIndex(2);
  await configure({ autoplay: true, index: 1 });
  await leave(); await advance(); await expectIndex(2);
  await advance(3000); await expectIndex(2);
  await clickControl('Start autoplay'); await expectIndex(0);
  await leave(); await advance(); await expectIndex(1);

  await configure({ items: ['Only'] }); await expectIndex(0);
  assert.equal(await carousel.getByRole('button').count(), 0);
  const changeCount = (await state()).changes.length;
  await advance(3000); assert.equal((await state()).changes.length, changeCount);
  await configure({ items: [] }); await expectIndex(0);
  assert.equal(await carousel.getByText('No slides').count(), 1);
  await configure({ items: ['Alpha', 'Bravo', 'Charlie'], loop: true, index: 99, interval: 0 }); await expectIndex(2);
  await advance(999); await expectIndex(2);
  await advance(1); await expectIndex(0);
  await configure({ interval: Number.NaN, index: -2 }); await expectIndex(0);
  await advance(4999); await expectIndex(0);
  await advance(1); await expectIndex(1);
  await configure({ index: Number.NaN }); await expectIndex(0);

  await configure({ autoplay: true }); await leave();
  // Removing the focused navigation key must not leave focus-pause latched.
  await configure({ interval: 1000 });
  await carousel.getByRole('button', { name: 'Go to slide 2', exact: true }).focus();
  await page.mouse.move(0, 0);
  await configure({ items: [] });
  await configure({ items: ['Alpha', 'Bravo', 'Charlie'] });
  await advance(); await expectIndex(1);
  await configure({ mounted: false });
  const beforeUnmount = (await state()).changes.length;
  await advance(10000); assert.equal((await state()).changes.length, beforeUnmount, 'unmount clears timer');

  // Exercise the actual routed showcase plus two existing application pages.
  await page.clock.resume();
  builtRuntime = await startUiRuntime({ mode: 'built-page' });
  origin = builtRuntime.origin;
  await page.goto(`${origin}/#/design`);
  await page.getByTestId('page-design').waitFor();
  {

      const example = page.getByTestId('design-carousel');
      await example.scrollIntoViewIfNeeded();
      await example.screenshot({ path: '/tmp/bungee-carousel-desktop.png' });
      const manual = page.getByRole('region', { name: '手动轮播示例 / Manual example' });
      await manual.hover();
      await manual.getByRole('button', { name: '下一项 / Next slide', exact: true }).click();
      assert.equal(await manual.locator('[aria-current="true"]').getAttribute('aria-label'), '切换到第 2 项 / Go to slide 2');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert(await example.evaluate(el => el.scrollWidth <= el.clientWidth), `carousel should fit ${width}px viewport`);
        await example.screenshot({ path: `/tmp/bungee-carousel-mobile-${width}.png` });
      }
      await page.setViewportSize({ width: 1200, height: 900 });
  }
  assert.deepEqual(errors, [], 'browser must have no runtime, console, or request errors');
  console.log('PASS: autoplay, pause/resume, keyboard, controls, persistence, dynamic data, reduced motion, timer cleanup, responsive showcase and production showcase');
} finally {
  try { await browser?.close(); } finally { try { await builtRuntime?.close(); } finally { await uiRuntime.close(); } }
}
}, 240_000);
