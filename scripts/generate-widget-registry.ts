#!/usr/bin/env bun

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildPluginManifestCatalog } from '../packages/core/src/plugin-manifest-catalog/catalog';

const ROOT_DIR = resolve(import.meta.dir, '..');

export interface WidgetRegistryOptions {
  pluginsDirectory: string;
  outputFile: string;
}

type ComponentInfo = Readonly<{ name: string; pluginName: string; importPath: string }>;

function render(components: readonly ComponentInfo[]): string {
  const imports = components.map((component) =>
    `import ${component.name} from '${component.importPath}';`).join('\n');
  const registryEntries = components.map(({ name }) => `  ${name},`).join('\n');
  const sources = components.map(({ name, pluginName }) => `  ${name}: '${pluginName}',`).join('\n');
  return `/**
 * 自动生成的原生组件注册表
 *
 * 此文件由 scripts/generate-widget-registry.ts 自动生成，请勿手动修改。
 */

import type { ComponentType, SvelteComponent } from 'svelte';

${imports}

export const generatedWidgetRegistry: Record<string, ComponentType<SvelteComponent>> = {
${registryEntries}
};

export const componentSourceMap: Record<string, string> = {
${sources}
};
`;
}

export async function generateWidgetRegistry(options: WidgetRegistryOptions): Promise<void> {
  const pluginsDirectory = resolve(options.pluginsDirectory);
  const outputFile = resolve(options.outputFile);
  const catalog = await buildPluginManifestCatalog({ scanDirectories: [pluginsDirectory] });
  const names = new Set<string>();
  const components: ComponentInfo[] = [];
  for (const record of catalog.records()) {
    for (const component of record.manifest.ui?.components ?? []) {
      if (names.has(component.name)) throw new Error(`Duplicate native component ${component.name}`);
      names.add(component.name);
      components.push({
        name: component.name,
        pluginName: record.name,
        importPath: `@plugins/${record.name}/${component.entry.replaceAll('\\', '/')}`,
      });
    }
  }
  for (const record of catalog.records()) {
    const name = record.manifest.contributes?.nativeSettingsComponent;
    if (name !== undefined && (!record.manifest.builtin || record.manifest.uiExtensionMode !== 'native-static'
      || !record.manifest.capabilities.includes('nativeWidgetsStatic')
      || !components.some(component => component.name === name && component.pluginName === record.name))) {
      throw new Error(`Native settings component ${name} is missing or not owned by ${record.name}`);
    }
  }
  const code = render(components);
  await mkdir(dirname(outputFile), { recursive: true });
  const temporary = join(dirname(outputFile), `.${Bun.randomUUIDv7()}.tmp`);
  await writeFile(temporary, code, 'utf8');
  await rename(temporary, outputFile);
}

if (import.meta.main) {
  const options = {
    pluginsDirectory: Bun.env.BUNGEE_WIDGET_PLUGINS_DIR ?? join(ROOT_DIR, 'plugins'),
    outputFile: Bun.env.BUNGEE_WIDGET_OUTPUT_FILE
      ?? join(ROOT_DIR, 'packages/ui/src/components/native-widgets/generated.ts'),
  };
  generateWidgetRegistry(options).catch((error) => {
    console.error('Widget registry generation failed:', error);
    process.exitCode = 1;
  });
}
