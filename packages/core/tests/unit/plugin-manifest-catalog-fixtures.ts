import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildPluginManifestCatalog,
  PluginManifestCatalogError,
} from '../../src/plugin-manifest-catalog';

const roots: string[] = [];
export const BUILTINS = resolve(import.meta.dir, '../../../../plugins');

export function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-manifest-catalog-'));
  roots.push(root);
  return root;
}

export function manifest(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    schemaVersion: 2,
    artifactKind: 'runtime-plugin',
    main: 'server/index.ts',
    capabilities: ['hooks', 'dynamicRuntimeLoad'],
    uiExtensionMode: 'none',
    engines: { bungee: '^4.2.0' },
    configSchema: [],
    ...overrides,
  };
}

export function writePlugin(
  root: string,
  name: string,
  value = manifest(name),
  source = 'throw new Error("must not import");\n',
): string {
  const directory = join(root, name);
  mkdirSync(join(directory, 'server'), { recursive: true });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(value, null, 2));
  writeFileSync(join(directory, 'server/index.ts'), source);
  return directory;
}

export async function expectCatalogError(scanDirectories: readonly string[], fragment: string): Promise<void> {
  let caught: unknown;
  try {
    await buildPluginManifestCatalog({ scanDirectories });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PluginManifestCatalogError);
  expect(String(caught)).toContain(fragment);
}

export function cleanupCatalogRoots(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
import { expect } from 'bun:test';
