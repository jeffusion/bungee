#!/usr/bin/env bun
/**
 * 编译 main.ts 为独立二进制文件
 * 用法: bun scripts/build-binaries.ts
 */

import { $ } from 'bun';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const binDir = join(import.meta.dir, '../bin');
const mainSrc = join(import.meta.dir, '../packages/core/src/main.ts');

// 确保 bin 目录存在
if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
}

console.log('🔨 Building binaries...\n');

const targets = [
  { name: 'bungee-linux', target: 'bun-linux-x64' },
  { name: 'bungee-linux-arm64', target: 'bun-linux-arm64' },
  { name: 'bungee-macos', target: 'bun-darwin-x64' },
  { name: 'bungee-macos-arm64', target: 'bun-darwin-arm64' },
  { name: 'bungee-windows.exe', target: 'bun-windows-x64' },
];

for (const { name, target } of targets) {
  const outfile = join(binDir, name);
  console.log(`📦 Building ${name} (${target})...`);

  try {
    await $`bun build --compile --target=${target} ${mainSrc} --outfile ${outfile}`;
    console.log(`✓ ${name} built successfully\n`);
  } catch (error) {
    console.error(`❌ Failed to build ${name}:`, error);
    process.exit(1);
  }
}

console.log('✅ All binaries built successfully!');
console.log(`📁 Output directory: ${binDir}\n`);

// 清理 .bun-build 临时文件（在项目根目录）
console.log('🧹 Cleaning up temporary files...');
try {
  const rootDir = join(import.meta.dir, '..');
  const files = readdirSync(rootDir);
  let cleanedCount = 0;

  for (const file of files) {
    if (file.endsWith('.bun-build')) {
      const filePath = join(rootDir, file);
      unlinkSync(filePath);
      cleanedCount++;
      console.log(`   Removed: ${file}`);
    }
  }

  if (cleanedCount > 0) {
    console.log(`✓ Cleaned up ${cleanedCount} temporary file(s)\n`);
  } else {
    console.log('✓ No temporary files to clean\n');
  }
} catch (error) {
  console.warn('⚠️  Failed to clean up temporary files:', error);
}