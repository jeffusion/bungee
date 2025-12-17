#!/usr/bin/env bun
/**
 * 外部插件构建脚本
 *
 * 功能：
 * - 扫描 plugins/ 目录下的所有插件
 * - 编译服务端代码到 packages/core/dist/plugins/{pluginName}/index.js
 * - 保持与 plugin-registry.ts 的搜索路径一致
 */

import * as fs from 'fs';
import * as path from 'path';

// 获取项目根目录（scripts 的父目录）
const ROOT_DIR = path.resolve(import.meta.dir, '..');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const OUTPUT_DIR = path.join(ROOT_DIR, 'packages/core/dist/plugins');

async function buildExternalPlugins() {
  console.log('Building external plugins...');
  console.log(`  Source: ${PLUGINS_DIR}`);
  console.log(`  Output: ${OUTPUT_DIR}`);

  // 检查 plugins 目录是否存在
  if (!fs.existsSync(PLUGINS_DIR)) {
    console.log('  No plugins directory found, skipping.');
    return;
  }

  // 扫描所有插件目录
  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const pluginDirs = entries.filter(e => e.isDirectory());

  if (pluginDirs.length === 0) {
    console.log('  No plugins found.');
    return;
  }

  for (const dir of pluginDirs) {
    const pluginName = dir.name;
    const serverEntry = path.join(PLUGINS_DIR, pluginName, 'server', 'index.ts');

    // 检查服务端入口是否存在
    if (!fs.existsSync(serverEntry)) {
      console.log(`  Skipping ${pluginName}: no server/index.ts found`);
      continue;
    }

    const outputPath = path.join(OUTPUT_DIR, pluginName);

    // 确保输出目录存在
    fs.mkdirSync(outputPath, { recursive: true });

    console.log(`  Building ${pluginName}...`);

    // 使用 Bun.build API 编译
    const result = await Bun.build({
      entrypoints: [serverEntry],
      outdir: outputPath,
      target: 'bun',
      format: 'esm',
      naming: 'index.js',
      minify: false,
      sourcemap: 'external',
    });

    if (!result.success) {
      console.error(`  ❌ Failed to build ${pluginName}:`);
      for (const log of result.logs) {
        console.error(`     ${log}`);
      }
      continue;
    }

    // 复制 manifest.json（如果存在）
    const manifestSrc = path.join(PLUGINS_DIR, pluginName, 'manifest.json');
    const manifestDst = path.join(outputPath, 'manifest.json');
    if (fs.existsSync(manifestSrc)) {
      fs.copyFileSync(manifestSrc, manifestDst);
      console.log(`  ✓ ${pluginName}/manifest.json copied`);
    }

    console.log(`  ✓ ${pluginName} → ${path.relative(process.cwd(), outputPath)}/index.js`);
  }

  console.log('External plugins build complete.');
}

// 执行构建
buildExternalPlugins().catch(error => {
  console.error('Build failed:', error);
  process.exit(1);
});
