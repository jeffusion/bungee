import { describe, expect, test } from 'bun:test';
import { parse } from 'svelte/compiler';

const source = await Bun.file(new URL('./PluginHost.svelte', import.meta.url)).text();
const ast = parse(source, { modern: true });
const syncTheme = ast.instance!.content.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'syncTheme') as unknown as { start: number; end: number };
// Execute the actual message producer, without an iframe network dependency.
const sync = new Function('bridge', 'document', `${source.slice(syncTheme.start!, syncTheme.end!)}; syncTheme();`);

describe('PluginHost theme protocol', () => {
  test.each([['industrial', 'dark'], ['dark', 'dark'], ['light', 'light'], [null, 'light']])('%s sends the compatible %s semantic theme', (theme, expected) => {
    const messages: unknown[][] = [];
    sync({ generation: 3, nonce: 'nonce', port: { postMessage: (...args: unknown[]) => messages.push(args) } },
      { documentElement: { getAttribute: () => theme } });
    expect(messages).toEqual([[{ type: 'bungee:theme', generation: 3, nonce: 'nonce', theme: expected }]]);
  });

  test('does not send before the iframe window exists', () => {
    expect(() => sync(undefined, {})).not.toThrow();
  });
});
