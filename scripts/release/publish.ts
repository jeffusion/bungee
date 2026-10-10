#!/usr/bin/env bun
/**
 * 手动发布所有包到 npm
 * 用法: bun scripts/release/publish.ts [--dry-run] [--ci]
 */

import { $ } from 'bun';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const dryRun = process.argv.includes('--dry-run');
const ciMode = process.argv.includes('--ci');

const packages = [
  { name: '@jeffusion/bungee-types', path: 'packages/types' },
  { name: '@jeffusion/bungee-core', path: 'packages/core' },
  { name: '@jeffusion/bungee-llms', path: 'packages/llms' },
  { name: '@jeffusion/bungee', path: 'packages/cli' },
];

const MIN_TRUSTED_PUBLISHING_NPM: [number, number, number] = [11, 5, 1];
const TARGET_TRUSTED_PUBLISHING_NPM = '11.6.2';

function getNpmCommand(): string {
  return process.env.NPM_BIN?.trim() || 'npm';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNpmScopePublish404(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes('npm error code E404')
    || (message.includes('npm error 404') && message.includes('Not Found - PUT https://registry.npmjs.org/@'))
    || (message.includes('404 Not Found - PUT https://registry.npmjs.org/@'));
}

function isVersionAlreadyPublished(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes('You cannot publish over the previously published versions')
    || message.includes('EPUBLISHCONFLICT');
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

function isVersionLowerThan(current: [number, number, number], required: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (current[i] < required[i]) {
      return true;
    }
    if (current[i] > required[i]) {
      return false;
    }
  }

  return false;
}

async function verifyTrustedPublishingPrerequisites(): Promise<void> {
  if (!process.env.GITHUB_ACTIONS) {
    console.error('❌ CI mode requires GitHub Actions for npm Trusted Publishing');
    process.exit(1);
  }

  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    console.error('❌ Missing GitHub OIDC environment. Ensure workflow permissions include id-token: write');
    process.exit(1);
  }

  let npmVersionText = '';
  const npmCommand = getNpmCommand();
  try {
    npmVersionText = (await $`${npmCommand} --version`.text()).trim();
  } catch (error) {
    console.error('❌ Failed to detect npm version for Trusted Publishing:', error);
    process.exit(1);
  }

  let parsedNpmVersion = parseSemver(npmVersionText);
  if (!parsedNpmVersion) {
    console.error(`❌ Unable to parse npm version: ${npmVersionText}`);
    process.exit(1);
  }

  if (isVersionLowerThan(parsedNpmVersion, MIN_TRUSTED_PUBLISHING_NPM)) {
    console.warn(`⚠️  npm ${npmVersionText} is too old. Upgrading to npm ${TARGET_TRUSTED_PUBLISHING_NPM} for Trusted Publishing...`);
    try {
      await $`${npmCommand} install -g npm@${TARGET_TRUSTED_PUBLISHING_NPM}`;
      npmVersionText = (await $`${npmCommand} --version`.text()).trim();
      parsedNpmVersion = parseSemver(npmVersionText);
      if (!parsedNpmVersion || isVersionLowerThan(parsedNpmVersion, MIN_TRUSTED_PUBLISHING_NPM)) {
        console.error(`❌ npm ${npmVersionText} is too old for Trusted Publishing after upgrade. Require npm >= ${MIN_TRUSTED_PUBLISHING_NPM.join('.')}`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`❌ Failed to upgrade npm to ${TARGET_TRUSTED_PUBLISHING_NPM} for Trusted Publishing:`, error);
      process.exit(1);
    }
  }

  console.log(`✓ Using npm command: ${npmCommand}`);
  console.log(`✓ Trusted Publishing prerequisites verified (npm ${npmVersionText})\n`);
}

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
  process.chdir(resolve(import.meta.dir, '../..'));
  console.log(`\n${'='.repeat(60)}`);
  if (dryRun) {
    console.log('🧪 DRY RUN MODE');
  } else if (ciMode) {
    console.log('🤖 CI MODE - AUTOMATED PUBLISHING');
  } else {
    console.log('📦 PUBLISHING TO NPM');
  }
  console.log(`${'='.repeat(60)}\n`);

  if (ciMode && !dryRun) {
    console.log('🔐 Verifying npm Trusted Publishing prerequisites...\n');
    await verifyTrustedPublishingPrerequisites();
  }

  // 1. 确保已完整构建（包括二进制文件）
  console.log('📦 Building all packages and binaries...\n');
  const npmCommand = getNpmCommand();
  await $`${npmCommand} run build:full`;

  // 2. 发布每个包
  const backups: Array<{ path: string; content: string }> = [];
  const packDirectory = dryRun ? mkdtempSync(join(tmpdir(), 'bungee-pack-')) : undefined;

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
          await $`cd ${pkg.path} && ${npmCommand} pack --pack-destination ${packDirectory!}`;
          console.log(`✓ ${pkg.name} packed successfully\n`);
        } else {
          if (ciMode) {
            await $`cd ${pkg.path} && npx --yes npm@${TARGET_TRUSTED_PUBLISHING_NPM} publish --access public`;
          } else {
            await $`cd ${pkg.path} && ${npmCommand} publish --access public`;
          }
          console.log(`✅ ${pkg.name}@${pkgJson.version} published!\n`);
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);

        if (isVersionAlreadyPublished(error)) {
          console.log(`⚠️  ${pkg.name}@${pkgJson.version} already exists on npm, skipping...\n`);
          continue;
        }

        console.error(`❌ Failed to publish ${pkg.name}:`, error);
        if (isNpmScopePublish404(error)) {
          console.error(`❌ Trusted Publishing rejected for ${pkg.name}. Check npm package Trusted Publisher settings (repository/workflow/branch/environment).`);
          console.error('   Also ensure this workflow has id-token: write and runs with npm >= 11.5.1.');
        }
        if (errorMessage.includes('ENEEDAUTH') || errorMessage.includes('E401')) {
          console.error('❌ npm authentication failed under Trusted Publishing. Ensure OIDC is enabled and remove legacy token-only auth assumptions.');
        }
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

      if (!ciMode) {
        const rootPkg = JSON.parse(readFileSync('package.json', 'utf-8'));
        const version = rootPkg.version;

        console.log('\n📤 Uploading binaries to GitHub Release...\n');
        try {
          await $`bun scripts/release/upload-binaries.ts ${version}`;
          console.log(`\n✅ Binaries uploaded to GitHub Release v${version}`);
        } catch (error) {
          console.error('\n❌ Failed to upload binaries:', (error as Error).message);
          console.error('⚠️  Please upload manually: bun scripts/release/upload-binaries.ts ' + version);
          throw error;
        }
      }
    }
  } finally {
    // 恢复所有备份的 package.json
    console.log('\n📝 Restoring original package.json files...\n');
    for (const backup of backups) {
      writeFileSync(backup.path, backup.content);
      console.log(`✓ Restored ${backup.path}`);
    }

    // 仅清理本次 dry-run 创建的临时打包目录。
    if (packDirectory) rmSync(packDirectory, { recursive: true, force: true });
  }
}

publish().catch((error) => {
  console.error('❌ Publish failed:', error);
  process.exit(1);
});
