import { describe, expect, test } from 'bun:test';
import { createProgram } from './index';

function command(name: string) {
  const result = createProgram().commands.find((candidate) => candidate.name() === name);
  if (result === undefined) throw new Error(`Command ${name} is not registered`);
  return result;
}

describe('management command registration', () => {
  for (const name of ['ui', 'export', 'import']) {
    test(`${name} parses the Management server default port`, async () => {
      const cli = createProgram();
      const registered = cli.commands.find((candidate) => candidate.name() === name);
      if (registered === undefined) throw new Error(`Command ${name} is not registered`);
      let parsed: Record<string, string | undefined> | undefined;
      registered.action((options: Record<string, string | undefined>) => {
        parsed = options;
      });

      const args = name === 'export'
        ? ['node', 'bungee', name, '--file', '/tmp/config.json']
        : name === 'import'
          ? ['node', 'bungee', name, '--file', '/tmp/config.json']
          : ['node', 'bungee', name];
      await cli.parseAsync(args);
      expect(parsed?.port).toBe('8089');
    });
  }

  test('registers Management server help and port defaults', () => {
    for (const name of ['ui', 'export', 'import']) {
      const registered = command(name);
      const port = registered.options.find((option) => option.long === '--port');
      expect(port?.defaultValue).toBe('8089');
      expect(registered.helpInformation()).toContain('Management server port');
      expect(registered.helpInformation()).toContain('Management server host');
    }
  });
});
