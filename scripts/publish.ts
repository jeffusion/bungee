#!/usr/bin/env bun
/**
 * 手动发布所有包到 npm
 * 用法: bun scripts/publish.ts [--dry-run] [--ci]
 */

import { $ } from 'bun';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const dryRun = process.argv.includes('--dry-run');
const ciMode = process.argv.includes('--ci');

const packages = [
  { name: '@jeffusion/bungee-types', path: 'packages/types' },
  { name: '@jeffusion/bungee-core', path: 'packages/core' },
  { name: '@jeffusion/bungee', path: 'packages/cli' },
];

// 替换 workspace:* 为实际版本号
function replaceWorkspaceDeps(pkgJson: any, version: string): any {
  const modified = { ...pkgJson };

  if (modified.dependencies) {
    for (const dep in modified.dependencies) {
      if (modified.dependencies[dep] === 'workspace:*') {
        modified.dependencies[dep] = `^${version}`;
      }
    }
  }

  if (modified.devDependencies) {
    for (const dep in modified.devDependencies) {
      if (modified.devDependencies[dep] === 'workspace:*') {
        modified.devDependencies[dep] = `^${version}`;
      }
    }
  }

  return modified;
}

async function publish() {
  console.log(`\n${'='.repeat(60)}`);
  if (dryRun) {
    console.log('🧪 DRY RUN MODE');
  } else if (ciMode) {
    console.log('🤖 CI MODE - AUTOMATED PUBLISHING');
  } else {
    console.log('📦 PUBLISHING TO NPM');
  }
  console.log(`${'='.repeat(60)}\n`);

  // 在 CI 模式下配置 npm token
  if (ciMode && !dryRun) {
    const npmToken = process.env.NPM_TOKEN;
    if (!npmToken) {
      console.error('❌ NPM_TOKEN environment variable is required in CI mode');
      process.exit(1);
    }

    console.log('🔐 Configuring npm authentication...\n');
    try {
      await $`npm config set //registry.npmjs.org/:_authToken ${npmToken}`;
      console.log('✓ npm authentication configured\n');
    } catch (error) {
      console.error('❌ Failed to configure npm authentication:', error);
      process.exit(1);
    }
  }

  // 1. 确保已完整构建（包括二进制文件）
  console.log('📦 Building all packages and binaries...\n');
  await $`npm run build:full`;

  // 2. 发布每个包
  const backups: Array<{ path: string; content: string }> = [];

  try {
    for (const pkg of packages) {
      const pkgJsonPath = join(pkg.path, 'package.json');
      const originalContent = readFileSync(pkgJsonPath, 'utf-8');
      const pkgJson = JSON.parse(originalContent);

      if (pkgJson.private) {
        console.log(`⏭️  Skipping ${pkg.name} (private)\n`);
        continue;
      }

      console.log(`\n${'─'.repeat(60)}`);
      console.log(`📦 Publishing ${pkg.name}@${pkgJson.version}`);
      console.log(`${'─'.repeat(60)}\n`);

      // 备份原始 package.json
      backups.push({ path: pkgJsonPath, content: originalContent });

      // 替换 workspace:* 依赖
      const modifiedPkgJson = replaceWorkspaceDeps(pkgJson, pkgJson.version);
      writeFileSync(pkgJsonPath, JSON.stringify(modifiedPkgJson, null, 2) + '\n');
      console.log('✓ Replaced workspace:* dependencies\n');

      try {
        if (dryRun) {
          // Dry run: 只打包不发布
          await $`cd ${pkg.path} && npm pack`;
          console.log(`✓ ${pkg.name} packed successfully\n`);
        } else {
          // 实际发布
          await $`cd ${pkg.path} && npm publish --access public`;
          console.log(`✅ ${pkg.name}@${pkgJson.version} published!\n`);
        }
      } catch (error) {
        console.error(`❌ Failed to publish ${pkg.name}:`, error);
        throw error;
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    if (dryRun) {
      console.log('✅ DRY RUN COMPLETED');
      console.log(`${'='.repeat(60)}\n`);
    } else {
      console.log('✅ ALL PACKAGES PUBLISHED');
      console.log(`${'='.repeat(60)}\n`);

      // 3. 获取版本号并上传二进制文件到 GitHub Release
      const rootPkg = JSON.parse(readFileSync('package.json', 'utf-8'));
      const version = rootPkg.version;

      console.log('\n📤 Uploading binaries to GitHub Release...\n');
      try {
        await $`bun scripts/upload-binaries.ts ${version}`;
        console.log(`\n✅ Binaries uploaded to GitHub Release v${version}`);
      } catch (error) {
        console.error('\n❌ Failed to upload binaries:', (error as Error).message);
        console.error('⚠️  Please upload manually: bun scripts/upload-binaries.ts ' + version);
        // 不退出，因为 npm 发布已经成功
      }
    }
  } finally {
    // 恢复所有备份的 package.json
    console.log('\n📝 Restoring original package.json files...\n');
    for (const backup of backups) {
      writeFileSync(backup.path, backup.content);
      console.log(`✓ Restored ${backup.path}`);
    }

    // 清理临时 tarball 文件
    console.log('\n🧹 Cleaning up temporary files...\n');
    try {
      const { readdirSync, unlinkSync } = await import('fs');
      const { join } = await import('path');

      // 清理各个包目录下的 tarball 文件
      for (const pkg of packages) {
        const files = readdirSync(pkg.path).filter(f => f.endsWith('.tgz'));
        for (const file of files) {
          unlinkSync(join(pkg.path, file));
          console.log(`✓ Cleaned up ${pkg.path}/${file}`);
        }
      }

      // 清理根目录的 tarball 文件
      const rootFiles = readdirSync('.').filter(f => f.endsWith('.tgz'));
      for (const file of rootFiles) {
        unlinkSync(file);
        console.log(`✓ Cleaned up ${file}`);
      }

      if (rootFiles.length === 0 && packages.every(pkg => readdirSync(pkg.path).filter(f => f.endsWith('.tgz')).length === 0)) {
        console.log('✓ No tarball files to clean up');
      }
    } catch (error) {
      console.warn('⚠️  Failed to clean up tarball files:', error);
    }
  }
}

publish().catch((error) => {
  console.error('❌ Publish failed:', error);
  process.exit(1);
});