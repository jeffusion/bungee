import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dir, '../../../..');
const productionRoots = [
  join(workspaceRoot, 'packages/core/src'),
  join(workspaceRoot, 'packages/ui/src'),
  join(workspaceRoot, 'plugins'),
];

const forbiddenPatterns = [
  /LegacyCompatAdapter/,
  /legacy-plugin-adapter/,
  /legacy-compat/,
  /PLUGIN_MANIFEST_LEGACY_WARNING/,
  /hasVNextContractFields/,
  /inferLegacyCapabilities/,
  /inferLegacyUiExtensionMode/,
  /isDevelopmentCompatPluginPath/,
  /metadata\??\.menus/,
  /\bmenus\??\s*:/,
  /InterceptResult\s*\|\s*Response/,
];

describe('strict plugin v2 production guard', () => {
  test('keeps removed compatibility symbols out of production sources', () => {
    // Given
    const sourceFiles = productionRoots.flatMap((root) =>
      readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((entry) => ['.ts', '.svelte'].includes(extname(entry)))
        .map((entry) => join(root, entry)),
    );

    // When
    const violations = sourceFiles.flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      return forbiddenPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relative(workspaceRoot, filePath)}: ${pattern.source}`);
    });

    // Then
    expect(violations).toEqual([]);
    expect(existsSync(join(workspaceRoot, 'packages/core/src/compat/legacy-plugin-adapter.ts'))).toBe(false);
  });
});
