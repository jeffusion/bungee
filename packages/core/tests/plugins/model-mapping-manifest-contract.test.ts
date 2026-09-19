import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type ManifestSchemaField = { name?: string; type?: string; catalogPlugin?: string };
type ManifestApiField = { path?: string; methods?: string[]; handler?: string; execution?: string };
type ManifestData = {
  artifactKind?: string;
  capabilities?: string[];
  control?: { entry?: string };
  configSchema?: ManifestSchemaField[];
  contributes?: {
    api?: ManifestApiField[];
    settings?: string;
  };
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(currentDir, '../../../../plugins/model-mapping/manifest.json');

async function loadManifest(): Promise<ManifestData> {
  return JSON.parse(await Bun.file(manifestPath).text()) as ManifestData;
}

describe('model-mapping manifest contract', () => {
  test('should expose standalone model mapping schema and management settings page', async () => {
    const manifest = await loadManifest();
    expect(manifest.artifactKind).toBe('runtime-plugin');
    expect(manifest.capabilities).toContain('controlPlane');
    expect(manifest.control?.entry).toBe('server/control.ts');
    const fields = manifest.configSchema ?? [];
    const fieldNames = new Set(fields.map((field) => field.name).filter(Boolean));

    expect(fieldNames.has('sourceProvider')).toBe(false);
    expect(fieldNames.has('targetProvider')).toBe(false);
    expect(fieldNames.has('modelMappings')).toBe(true);

    const modelMappingField = fields.find((field) => field.name === 'modelMappings');
    expect(modelMappingField?.type).toBe('model_mapping');
    expect(modelMappingField?.catalogPlugin).toBe('model-mapping');

    expect(manifest.contributes?.settings).toBe('/catalog');
    expect(manifest.contributes?.api).toEqual([
      { path: '/catalog', methods: ['GET'], handler: 'getCatalog', execution: 'control' },
      { path: '/catalog/refresh', methods: ['POST'], handler: 'refreshCatalog', execution: 'control' },
    ]);
  });
});
