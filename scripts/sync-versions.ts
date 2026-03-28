#!/usr/bin/env bun
/**
 * 同步所有包的版本号
 * 用法: bun scripts/sync-versions.ts 1.2.3
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const newVersion = process.argv[2];

if (!newVersion) {
  console.error('❌ Usage: bun scripts/sync-versions.ts <version>');
  process.exit(1);
}

// 验证版本号格式
if (!/^\d+\.\d+\.\d+/.test(newVersion)) {
  console.error(`❌ Invalid version format: ${newVersion}`);
  process.exit(1);
}

const packagesDir = join(import.meta.dir, '../packages');
const packages = ['cli', 'core', 'types', 'ui', 'llms'];

console.log(`📦 Syncing version to ${newVersion}...`);

// 更新根 package.json
const rootPkgPath = join(import.meta.dir, '../package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
rootPkg.version = newVersion;
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');
console.log(`✓ Updated root package.json`);

// 更新所有子包
for (const pkg of packages) {
  const pkgPath = join(packagesDir, pkg, 'package.json');

  if (!existsSync(pkgPath)) {
    console.warn(`⚠️  Skipping ${pkg} (not found)`);
    continue;
  }

  const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkgJson.version = newVersion;

  // 更新 workspace 依赖版本
  if (pkgJson.dependencies) {
    for (const dep in pkgJson.dependencies) {
      if (dep.startsWith('@jeffusion/bungee-') || dep === '@jeffusion/bungee') {
        if (pkgJson.dependencies[dep].startsWith('workspace:')) {
          // 保持 workspace: 协议
          pkgJson.dependencies[dep] = 'workspace:*';
        }
      }
    }
  }

  writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n');
  console.log(`✓ Updated packages/${pkg}/package.json`);
}

console.log(`\n✅ All versions synced to ${newVersion}`);
