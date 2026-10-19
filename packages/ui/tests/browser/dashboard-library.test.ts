import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { readdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectDashboard } from '../helpers/dashboard/fixture';
import { BUILTIN_CARDS, LAYOUT_KEY } from '../../src/components/dashboard/layout';
const runtime = dashboardRuntime();
const evidence = '/tmp/bungee-dashboard-charts'; mkdirSync(evidence, { recursive: true });
async function open(page: import('playwright').Page) {
 const fixture = await connectDashboard(page);
 const ids = BUILTIN_CARDS.map(card => card.id);
 await page.addInitScript(({ key, ids }) => {
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 5,
   cards: ids.map((id, i) => ({ id, x: i % 2 * 15, y: Math.floor(i / 2) * 8, w: 15, h: 8 })),
   mobile: ids.map(id => ({ id, height: 'standard' })),
  }));
 }, { key: LAYOUT_KEY, ids });
 const chartChunk = (await readdir(new URL('../../dist/assets/', import.meta.url))).find(name => /^vendor-charts-.*\.js$/.test(name));
 if (!chartChunk) throw new Error('Current build has no Chart.js chunk');
 await page.addInitScript(url => { (window as any).__chartModuleUrl = url; }, `/assets/${chartChunk}`);
 await page.goto(runtime.origin); await expect(fixture.card('kpi.requests')).toBeVisible();
 return fixture;
}

test('Dashboard card library isolates scrolling, traps and restores focus, and animates desktop/mobile sheets', () => runtime.run(async page => {
 const fixture = await open(page);
 const { edit, closeLibrary, pageErrors } = fixture;
async function recordSheetMotion() {
  await page.evaluate(() => {
    (window as any).__sheetMotion = [];
    for (const phase of ['intro', 'outro']) document.addEventListener(`${phase}start`, event => {
      const node = event.target as HTMLElement;
      if (!node.matches('[data-sheet-content], [data-sheet-overlay]')) return;
      const trace = { phase, panel: node.hasAttribute('data-sheet-content'), done: false,
        samples: [] as { x: number; y: number; opacity: number; locked: boolean }[] };
      (window as any).__sheetMotion.push(trace);
      node.addEventListener(`${phase}end`, () => { trace.done = true; }, { once: true });
      const sample = () => {
        if (trace.done || !node.isConnected) return;
        const style = getComputedStyle(node), matrix = new DOMMatrix(style.transform);
        trace.samples.push({ x: matrix.m41, y: matrix.m42, opacity: Number(style.opacity),
          locked: getComputedStyle(document.body).overflow === 'hidden' });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, true);
  });
}

async function checkLibraryModal(width: number, dismiss: 'escape' | 'close' | 'overlay') {
  await page.setViewportSize({ width, height: 844 });
  const opener = width < 768 ? page.locator('.dashboard-add-row') : page.getByTestId('dashboard-add-card');
  await opener.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => ({ scrollY, x: document.querySelector('.dashboard-board')!.getBoundingClientRect().x }));
  await page.evaluate(() => { (window as any).__sheetMotion = []; });
  await opener.click();
  const panel = page.locator('[data-sheet-content]'), overlay = page.locator('[data-sheet-overlay]');
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => panel.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return Math.max(Math.abs(rect.top), Math.abs(rect.bottom - innerHeight), Math.abs(rect.right - innerWidth));
  })).toBeLessThan(1);
  await expect.poll(() => panel.evaluate(node => node.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
  expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, width, height: 844 });
  expect(await panel.evaluate(node => node.getBoundingClientRect().width)).toBe(width < 768 ? width : 392);
  expect(await page.evaluate(() => ({ scrollY, x: document.querySelector('.dashboard-board')!.getBoundingClientRect().x }))).toEqual(before);
  if (width >= 768) expect(await page.evaluate(() => document.elementFromPoint(10, 10)?.hasAttribute('data-sheet-overlay'))).toBe(true);
  await expect(panel.getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await panel.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await panel.evaluate(node => node.contains(document.activeElement))).toBe(true);
  const header = await panel.locator('header').boundingBox();
  await page.mouse.move(header!.x + 24, header!.y + 20); await page.mouse.wheel(0, 400);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => scrollY)).toBe(before.scrollY);
  const list = page.getByTestId('dashboard-library-list'), bounds = await list.boundingBox();
  await page.mouse.move(bounds!.x + 20, bounds!.y + 30); await page.mouse.wheel(0, 400);
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.mouse.wheel(0, 400); await page.waitForTimeout(100);
  expect(await page.evaluate(() => scrollY)).toBe(before.scrollY);
  await expect(panel.locator('header')).toBeInViewport();
  await expect(panel.locator('footer')).toBeInViewport();
  await page.screenshot({ path: `${evidence}/modal-${width}.png` });
  if (dismiss === 'escape') await page.keyboard.press('Escape');
  else if (dismiss === 'close') await panel.getByRole('button', { name: '关闭', exact: true }).click();
  else await overlay.click({ position: { x: 10, y: 400 } });
  await expect(panel).toHaveCount(0);
  await expect(overlay).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(before.scrollY);
  const motion = await page.evaluate(() => (window as any).__sheetMotion);
  for (const phase of ['intro', 'outro']) {
    const panelMotion = motion.find((trace: any) => trace.phase === phase && trace.panel);
    const overlayMotion = motion.find((trace: any) => trace.phase === phase && !trace.panel);
    expect(panelMotion?.done).toBe(true);
    expect(overlayMotion?.done).toBe(true);
    const distance = width < 768 ? 844 : 392;
    expect(panelMotion.samples.some((sample: any) => {
      const offset = width < 768 ? sample.y : sample.x;
      return offset > 1 && offset < distance - 1;
    })).toBe(true);
    expect(overlayMotion.samples.some((sample: any) => sample.opacity > 0 && sample.opacity < 1)).toBe(true);
    expect(panelMotion.samples.every((sample: any) => sample.locked)).toBe(true);
  }
}

 await edit(); await recordSheetMotion();
 for (const [width, dismiss] of [[1440, 'escape'], [390, 'close']] as const) await checkLibraryModal(width, dismiss);
 await page.emulateMedia({ reducedMotion: 'reduce' });
 await page.locator('.dashboard-add-row').click();
 await expect(page.getByRole('dialog')).toBeVisible();
 expect(await page.getByRole('dialog').evaluate(node => node.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
 await closeLibrary();
 await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 120_000);
