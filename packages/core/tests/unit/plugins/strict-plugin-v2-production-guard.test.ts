import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const workspaceRoot = resolve(import.meta.dir, '../../../../..');
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
  /InterceptResult\s*\|\s*Response/,
];

function declaresMetadataMenus(source: string): boolean {
  const tree = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  let found = false;
  const name = (node: ts.Node) => ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) ? (node.name as ts.Identifier).text : '';
  const visit = (node: ts.Node) => {
    if ((ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) && name(node) === 'menus'
      && name(node.parent.parent) === 'metadata') found = true;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

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
      const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relative(workspaceRoot, filePath)}: ${pattern.source}`);
      if (declaresMetadataMenus(source)) violations.push(`${relative(workspaceRoot, filePath)}: metadata.menus declaration`);
      return violations;
    });

    // Then
    expect(violations).toEqual([]);
    expect(existsSync(join(workspaceRoot, 'packages/core/src/compat/legacy-plugin-adapter.ts'))).toBe(false);
  });
  test('distinguishes removed metadata menus from translation data and string payloads', () => {
    expect(declaresMetadataMenus('const manifest = { metadata: { menus: [] } };')).toBe(true);
    expect(declaresMetadataMenus('interface Manifest { metadata?: { menus?: string[] } }')).toBe(true);
    expect(declaresMetadataMenus('const messages = { menus: { more: "More menus" } };')).toBe(false);
    expect(declaresMetadataMenus('const bundle = "menus:{more:1}";')).toBe(false);
  });
});
