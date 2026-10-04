/** Native wheel/touch acceptance on real components and the live design example; no API mocks. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import appConfig from '../vite.config';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = await mkdtemp(join(tmpdir(), 'bungee-carousel-scroll-'));
process.chdir(root);
const server = await createServer({ ...appConfig, configFile: false, root, cacheDir: join(evidence, 'cache'),
  optimizeDeps: { entries: ['tests/fixtures/carousel.ts', 'tests/fixtures/oauth.ts'], exclude: ['svelte-spa-router'] },
  server: { host: '127.0.0.1', port: 0, proxy: {} } });
const browser = await chromium.launch({ headless: true });
try {
  await server.listen();
  const address = server.httpServer!.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors: string[] = [];
  const observe = (target: typeof page) => {
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    target.on('requestfailed', request => errors.push(`Request failed: ${request.url()}`));
  };
  observe(page);
  await page.goto(`${origin}/tests/fixtures/carousel.html?scroll`);
  const carousel = page.getByRole('region', { name: 'Test carousel' });
  await carousel.waitFor();
  const slide = carousel.locator('[data-carousel-slide][aria-hidden="false"]');
  const configure = async (value: Record<string, unknown>) => {
    await page.evaluate(value => (window as any).carouselTest.configure(value), { autoplay: false, ...value });
    await page.waitForTimeout(200);
  };
  const index = () => page.evaluate(() => (window as any).carouselTest.state().index);
  const wheelPage = async (dy: number, label: string) => {
    await slide.hover({ position: { x: 20, y: 10 } });
    const before = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, dy);
    await page.waitForFunction(({ before, dy }) => dy > 0 ? scrollY > before : scrollY < before, { before, dy });
    console.log(`${label}: page ${before} -> ${await page.evaluate(() => scrollY)}`);
    assert.equal(await index(), 0, 'vertical wheel must not navigate slides');
    await page.waitForTimeout(150); // End the native wheel sequence before changing its scroll target.
  };

  for (const width of [1200, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const effect of ['fade', 'slide']) {
      await configure({ items: ['Alpha', 'Bravo', 'Charlie'], compact: true, effect, longContent: false, index: 0 });
      await page.evaluate(() => scrollTo(0, 200));
      assert(await slide.evaluate(el => el.scrollHeight <= el.clientHeight), 'short slide has no vertical overflow');
      await wheelPage(120, `${width}/${effect}/short down`);
      await wheelPage(-120, `${width}/${effect}/short up`);

      await configure({ longContent: true });
      await page.evaluate(() => scrollTo(0, 200));
      await slide.evaluate(el => { el.scrollTop = 0; });
      assert(await slide.evaluate(el => el.scrollHeight > el.clientHeight), 'long slide overflows');
      await slide.hover({ position: { x: 20, y: 10 } });
      const outer = await page.evaluate(() => scrollY);
      await page.mouse.wheel(0, 80);
      await page.waitForFunction(() => document.querySelector('[data-carousel-slide][aria-hidden="false"]')!.scrollTop > 0);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => scrollY), outer, 'overflowing content scrolls before the page');
      await slide.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await wheelPage(120, `${width}/${effect}/bottom down`);
      await slide.evaluate(el => { el.scrollTop = 0; });
      await wheelPage(-120, `${width}/${effect}/top up`);
      assert.equal(await index(), 0);
      await carousel.screenshot({ path: join(evidence, `compact-${width}-${effect}.png`) });
    }
    await configure({ items: ['Only'], longContent: false });
    await page.evaluate(() => scrollTo(0, 200));
    assert.equal(await carousel.locator('[data-carousel-indicators]').count(), 0);
    await wheelPage(120, `${width}/single down`);
    await configure({ items: [], index: 0 });
    await carousel.getByText('No slides').hover();
    const before = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(before => scrollY < before, before);
    await configure({ items: ['Alpha', 'Bravo'], compact: false });
    await page.evaluate(() => scrollTo(0, 200));
    await wheelPage(120, `${width}/noncompact down`);
  }

  // The exact shared BCarouselList example that reproduced the reported failure.
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${origin}/tests/fixtures/oauth.html?design`);
  const adaptive = page.getByRole('region', { name: '按高度分屏示例 / Adaptive pages example' });
  const adaptiveSlide = adaptive.locator('[data-carousel-slide][aria-hidden="false"]');
  await adaptiveSlide.scrollIntoViewIfNeeded();
  await adaptiveSlide.hover();
  const before = await page.evaluate(() => scrollY);
  assert(before > 0);
  await page.mouse.wheel(0, -300);
  await page.waitForFunction(before => scrollY < before, before);
  console.log(`Design BCarouselList: page ${before} -> ${await page.evaluate(() => scrollY)}`);
  await page.getByTestId('design-carousel').screenshot({ path: join(evidence, 'design.png') });

  const mobile = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 900 } });
  observe(mobile);
  await mobile.goto(`${origin}/tests/fixtures/carousel.html?scroll`);
  const touchCarousel = mobile.getByRole('region', { name: 'Test carousel' });
  await touchCarousel.waitFor();
  const session = await mobile.context().newCDPSession(mobile);
  try {
    const current = touchCarousel.locator('[data-carousel-slide][aria-hidden="false"]');
    const selected = () => mobile.evaluate(() => (window as any).carouselTest.state().index);
    const swipe = async (dx: number, dy: number, yOffset = 10) => {
      const box = (await current.boundingBox())!;
      const x = box.x + box.width * .6, y = box.y + yOffset;
      if (dx) assert(await mobile.evaluate(({ x, y }) => !document.elementFromPoint(x, y)?.closest('button, a, input, textarea, select, label, summary, [role="button"]'), { x, y }), 'horizontal probe must start on content, not a nested control');
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 6; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await mobile.waitForTimeout(350);
    };
    await mobile.evaluate(() => (window as any).carouselTest.configure({ autoplay: false, compact: true, effect: 'slide', index: 0 }));
    await current.scrollIntoViewIfNeeded();
    await swipe(-100, 0); assert.equal(await selected(), 1, 'native left touch switches forward');
    await swipe(100, 0); assert.equal(await selected(), 0, 'native right touch switches back');
    const outer = await mobile.evaluate(() => scrollY);
    await swipe(0, -80);
    assert(await mobile.evaluate(() => scrollY) > outer, 'vertical touch on fitting content scrolls the page');
    assert.equal(await selected(), 0);
    await mobile.evaluate(() => (window as any).carouselTest.configure({ longContent: true }));
    await current.scrollIntoViewIfNeeded();
    await current.evaluate(el => { el.scrollTop = 0; });
    await swipe(0, -80);
    assert(await current.evaluate(el => el.scrollTop > 0), 'vertical touch still scrolls overflowing content');
    assert.equal(await selected(), 0);
    // After scrolling, the header position can contain an input/label, whose
    // gestures intentionally remain native. Start on the long content instead.
    await swipe(-100, 0, 150); assert.equal(await selected(), 1, 'horizontal touch still works inside a scrollable slide');
    await mobile.screenshot({ path: join(evidence, 'touch.png') });
  } finally { await session.detach(); await mobile.close(); }
  assert.deepEqual(errors, [], 'no browser/runtime/network errors');
  console.log(`PASS: native wheel chaining, short/long/empty/single, fade/slide, desktop/narrow, BCarouselList design, bidirectional touch and vertical touch. Evidence: ${evidence}`);
} finally {
  await browser.close();
  await server.close();
  await rm(join(evidence, 'cache'), { recursive: true, force: true });
}
