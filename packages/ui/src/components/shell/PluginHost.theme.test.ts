import { describe, expect, test } from 'bun:test';
import { parse } from 'svelte/compiler';

const source = await Bun.file(new URL('./PluginHost.svelte', import.meta.url)).text();
const ast = parse(source, { modern: true });
const syncTheme = ast.instance!.content.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'syncTheme') as unknown as { start: number; end: number };
// Execute the actual message producer, without an iframe network dependency.
const sync = new Function('iframe', 'document', 'pluginOrigin', `${source.slice(syncTheme.start!, syncTheme.end!)}; syncTheme();`);

describe('PluginHost theme protocol', () => {
  test.each([['industrial', 'dark'], ['dark', 'dark'], ['light', 'light'], [null, 'light']])('%s sends the compatible %s semantic theme', (theme, expected) => {
    const messages: unknown[][] = [];
    sync({ contentWindow: { postMessage: (...args: unknown[]) => messages.push(args) } },
      { documentElement: { getAttribute: () => theme } }, 'https://bungee.example');
    expect(messages).toEqual([[{ type: 'bungee:theme', theme: expected }, 'https://bungee.example']]);
  });

  test('does not send before the iframe window exists', () => {
    expect(() => sync(undefined, {}, 'https://bungee.example')).not.toThrow();
  });
});
