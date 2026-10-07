import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Supply catalog metadata for test artifacts that previously relied on class-only discovery. */
export function writeRuntimeTestManifest(entry: string, name: string): void {
  const manifestPath = join(dirname(entry), 'manifest.json');
  if (existsSync(manifestPath)) return;
  writeFileSync(manifestPath, JSON.stringify({
    name, version: '1.0.0', schemaVersion: 3, artifactKind: 'runtime-plugin',
    main: basename(entry), capabilities: ['hooks', 'dynamicRuntimeLoad'],
    uiExtensionMode: 'none', engines: { bungee: '*' },
  }));
}
