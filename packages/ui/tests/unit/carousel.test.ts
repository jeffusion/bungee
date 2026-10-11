import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

test('carousel and live example compile in runes mode for browser and SSR without warnings', () => {
  for (const name of ['BCarousel', 'BCarouselList', 'BCarouselExample']) {
    const filename = fileURLToPath(new URL(`../../src/components/industrial/${name}.svelte`, import.meta.url));
    for (const generate of ['client', 'server'] as const) {
      const result = compile(readFileSync(filename, 'utf8'), { filename, generate, runes: true });
      expect(result.warnings).toEqual([]);
    }
  }
});
