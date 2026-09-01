import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('widget registry generator', () => {
  test('fails closed when any scanned manifest is invalid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-widget-generator-'));
    roots.push(root);
    const pluginDir = join(root, 'bad-plugin');
    mkdirSync(pluginDir);
    writeFileSync(join(pluginDir, 'manifest.json'), '{"name":"bad-plugin","name":"shadowed"}');
    const output = join(root, 'generated.ts');

    const process = Bun.spawn({
      cmd: ['bun', resolve(import.meta.dir, '../../../../scripts/generate-widget-registry.ts')],
      env: { ...Bun.env, BUNGEE_WIDGET_PLUGINS_DIR: root, BUNGEE_WIDGET_OUTPUT_FILE: output },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(await process.exited).not.toBe(0);
  });

  test('rejects an existing code-injection entry before mutating output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-widget-generator-'));
    roots.push(root);
    const pluginDir = join(root, 'bad-plugin');
    mkdirSync(join(pluginDir, 'server'), { recursive: true });
    mkdirSync(join(pluginDir, 'ui'));
    const entry = "ui/x';process.exit();x.svelte";
    writeFileSync(join(pluginDir, 'server/index.ts'), 'export default {};');
    writeFileSync(join(pluginDir, entry), '<div />');
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({
      name: 'bad-plugin', version: '1.0.0', schemaVersion: 2,
      artifactKind: 'runtime-plugin', main: 'server/index.ts',
      capabilities: ['hooks', 'dynamicRuntimeLoad', 'nativeWidgetsStatic'],
      uiExtensionMode: 'native-static', engines: { bungee: '^4.2.0' },
      configSchema: [], ui: { components: [{ name: 'BadWidget', entry }] },
      contributes: { nativeWidgets: [{ id: 'bad-widget', title: 'Bad', size: 'small', component: 'BadWidget' }] },
    }));
    const output = join(root, 'generated.ts');
    writeFileSync(output, 'unchanged');

    const process = Bun.spawn({
      cmd: ['bun', resolve(import.meta.dir, '../../../../scripts/generate-widget-registry.ts')],
      env: { ...Bun.env, BUNGEE_WIDGET_PLUGINS_DIR: root, BUNGEE_WIDGET_OUTPUT_FILE: output },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(await process.exited).not.toBe(0);
    expect(await Bun.file(output).text()).toBe('unchanged');
  });

  test('rejects a reserved-word component before generating invalid imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-widget-generator-'));
    roots.push(root);
    const pluginDir = join(root, 'bad-plugin');
    mkdirSync(join(pluginDir, 'server'), { recursive: true });
    mkdirSync(join(pluginDir, 'ui'));
    writeFileSync(join(pluginDir, 'server/index.ts'), 'export default {};');
    writeFileSync(join(pluginDir, 'ui/widget.svelte'), '<div />');
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({
      name: 'bad-plugin', version: '1.0.0', schemaVersion: 2,
      artifactKind: 'runtime-plugin', main: 'server/index.ts',
      capabilities: ['hooks', 'dynamicRuntimeLoad', 'nativeWidgetsStatic'],
      uiExtensionMode: 'native-static', engines: { bungee: '^4.2.0' }, configSchema: [],
      ui: { components: [{ name: 'class', entry: 'ui/widget.svelte' }] },
      contributes: { nativeWidgets: [{ id: 'bad-widget', title: 'Bad', size: 'small', component: 'class' }] },
    }));
    const output = join(root, 'generated.ts');
    writeFileSync(output, 'unchanged');

    const process = Bun.spawn({
      cmd: ['bun', resolve(import.meta.dir, '../../../../scripts/generate-widget-registry.ts')],
      env: { ...Bun.env, BUNGEE_WIDGET_PLUGINS_DIR: root, BUNGEE_WIDGET_OUTPUT_FILE: output },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(await process.exited).not.toBe(0);
    expect(await Bun.file(output).text()).toBe('unchanged');
  });
});
