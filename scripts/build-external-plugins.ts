#!/usr/bin/env bun

import * as fs from 'fs';
import * as path from 'path';
import type { PluginManifest } from '../packages/core/src/plugin.types';

const ROOT_DIR = path.resolve(import.meta.dir, '..');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const OUTPUT_DIR = path.join(ROOT_DIR, 'packages/core/dist/plugins');

export function rewriteManifestForBuiltArtifact(manifest: PluginManifest): PluginManifest {
  return {
    ...manifest,
    main: 'index.js',
  };
}

async function buildExternalPlugins() {
  console.log('Building external plugins...');
  console.log(`  Source: ${PLUGINS_DIR}`);
  console.log(`  Output: ${OUTPUT_DIR}`);

  if (!fs.existsSync(PLUGINS_DIR)) {
    console.log('  No plugins directory found, skipping.');
    return;
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const pluginDirs = entries.filter(e => e.isDirectory());

  if (pluginDirs.length === 0) {
    console.log('  No plugins found.');
    return;
  }

  for (const dir of pluginDirs) {
    const pluginName = dir.name;
    const serverEntry = path.join(PLUGINS_DIR, pluginName, 'server', 'index.ts');

    if (!fs.existsSync(serverEntry)) {
      console.log(`  Skipping ${pluginName}: no server/index.ts found`);
      continue;
    }

    const outputPath = path.join(OUTPUT_DIR, pluginName);

    fs.mkdirSync(outputPath, { recursive: true });

    console.log(`  Building ${pluginName}...`);

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

    const manifestSrc = path.join(PLUGINS_DIR, pluginName, 'manifest.json');
    const manifestDst = path.join(outputPath, 'manifest.json');
    if (fs.existsSync(manifestSrc)) {
      const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf-8')) as PluginManifest;
      const builtManifest = rewriteManifestForBuiltArtifact(manifest);
      fs.writeFileSync(manifestDst, JSON.stringify(builtManifest, null, 2));
      fs.chmodSync(manifestDst, 0o644);
      console.log(`  ✓ ${pluginName}/manifest.json copied`);
    }

    const uiSrc = path.join(PLUGINS_DIR, pluginName, 'ui');
    const uiDst = path.join(outputPath, 'ui');
    if (fs.existsSync(uiSrc)) {
      fs.rmSync(uiDst, { recursive: true, force: true });
      fs.cpSync(uiSrc, uiDst, { recursive: true });
      console.log(`  ✓ ${pluginName}/ui copied`);
    }

    console.log(`  ✓ ${pluginName} → ${path.relative(process.cwd(), outputPath)}/index.js`);
  }

  console.log('External plugins build complete.');
}

if (import.meta.main) {
  buildExternalPlugins().catch(error => {
    console.error('Build failed:', error);
    process.exit(1);
  });
}
