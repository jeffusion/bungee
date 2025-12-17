#!/usr/bin/env bun
/**
 * 原生组件注册表生成脚本
 *
 * 功能：
 * - 扫描 plugins/ 目录下的 manifest.json 文件
 * - 提取 ui.components 配置
 * - 生成 packages/ui/src/lib/components/native-widgets/generated.ts
 *
 * 使用方式：
 * bun scripts/generate-widget-registry.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.resolve(import.meta.dir, '..');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const OUTPUT_FILE = path.join(
  ROOT_DIR,
  'packages/ui/src/lib/components/native-widgets/generated.ts'
);

interface ManifestComponent {
  name: string;
  entry: string;
}

interface PluginManifest {
  name: string;
  ui?: {
    components?: ManifestComponent[];
  };
}

interface ComponentInfo {
  name: string;
  pluginName: string;
  importPath: string;
}

async function generateWidgetRegistry() {
  console.log('Generating native widget registry...');
  console.log(`  Scanning: ${PLUGINS_DIR}`);

  const components: ComponentInfo[] = [];

  // 检查 plugins 目录是否存在
  if (!fs.existsSync(PLUGINS_DIR)) {
    console.log('  No plugins directory found.');
    await writeEmptyRegistry();
    return;
  }

  // 扫描所有插件目录
  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const pluginDirs = entries.filter((e) => e.isDirectory());

  for (const dir of pluginDirs) {
    const pluginName = dir.name;
    const manifestPath = path.join(PLUGINS_DIR, pluginName, 'manifest.json');

    // 检查 manifest.json 是否存在
    if (!fs.existsSync(manifestPath)) {
      console.log(`  Skipping ${pluginName}: no manifest.json`);
      continue;
    }

    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const manifest: PluginManifest = JSON.parse(content);

      // 检查是否有 UI 组件
      if (!manifest.ui?.components?.length) {
        console.log(`  Skipping ${pluginName}: no UI components`);
        continue;
      }

      // 收集组件信息
      for (const comp of manifest.ui.components) {
        components.push({
          name: comp.name,
          pluginName: manifest.name,
          importPath: `@plugins/${pluginName}/${comp.entry}`,
        });
        console.log(`  Found: ${comp.name} from ${pluginName}`);
      }
    } catch (error) {
      console.error(`  Error parsing ${manifestPath}:`, error);
    }
  }

  // 生成代码
  await writeRegistry(components);
  console.log(`Generated ${OUTPUT_FILE}`);
  console.log(`  Total components: ${components.length}`);
}

async function writeRegistry(components: ComponentInfo[]) {
  const imports = components
    .map((c) => `import ${c.name} from '${c.importPath}';`)
    .join('\n');

  const registryEntries = components.map((c) => `  ${c.name},`).join('\n');

  const code = `/**
 * 自动生成的原生组件注册表
 *
 * ⚠️ 此文件由 scripts/generate-widget-registry.ts 自动生成
 * ⚠️ 请勿手动修改，修改将在下次构建时被覆盖
 *
 * 如需添加新组件，请在插件的 manifest.json 中声明 ui.components
 *
 * 生成时间: ${new Date().toISOString()}
 */

import type { ComponentType, SvelteComponent } from 'svelte';

${imports}

/**
 * 组件注册表（自动生成）
 * key: 组件名称（与 nativeWidgets.component 对应）
 * value: Svelte 组件
 */
export const generatedWidgetRegistry: Record<string, ComponentType<SvelteComponent>> = {
${registryEntries}
};

/**
 * 组件来源映射（用于调试）
 */
export const componentSourceMap: Record<string, string> = {
${components.map((c) => `  ${c.name}: '${c.pluginName}',`).join('\n')}
};
`;

  // 确保目录存在
  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, code, 'utf-8');
}

async function writeEmptyRegistry() {
  const code = `/**
 * 自动生成的原生组件注册表
 *
 * ⚠️ 此文件由 scripts/generate-widget-registry.ts 自动生成
 * ⚠️ 请勿手动修改，修改将在下次构建时被覆盖
 *
 * 当前没有检测到任何插件 UI 组件
 *
 * 生成时间: ${new Date().toISOString()}
 */

import type { ComponentType, SvelteComponent } from 'svelte';

export const generatedWidgetRegistry: Record<string, ComponentType<SvelteComponent>> = {};
export const componentSourceMap: Record<string, string> = {};
`;

  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, code, 'utf-8');
}

// 执行生成
generateWidgetRegistry().catch((error) => {
  console.error('Generation failed:', error);
  process.exit(1);
});
