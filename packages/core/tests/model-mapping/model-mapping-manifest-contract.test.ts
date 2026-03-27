import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type ManifestSchemaField = { name?: string; type?: string; catalogPlugin?: string };
type ManifestApiField = { path?: string; methods?: string[]; handler?: string };
type ManifestData = {
  configSchema?: ManifestSchemaField[];
  contributes?: {
    api?: ManifestApiField[];
  };
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(currentDir, '../../../../plugins/model-mapping/manifest.json');

async function loadManifest(): Promise<ManifestData> {
  return JSON.parse(await Bun.file(manifestPath).text()) as ManifestData;
}

describe('model-mapping manifest contract', () => {
  test('should expose standalone model mapping schema and model catalog api', async () => {
    const manifest = await loadManifest();
    const fields = manifest.configSchema ?? [];
    const fieldNames = new Set(fields.map((field) => field.name).filter(Boolean));

    expect(fieldNames.has('sourceProvider')).toBe(false);
    expect(fieldNames.has('targetProvider')).toBe(false);
    expect(fieldNames.has('modelMappings')).toBe(true);

    const modelMappingField = fields.find((field) => field.name === 'modelMappings');
    expect(modelMappingField?.type).toBe('model_mapping');
    expect(modelMappingField?.catalogPlugin).toBe('model-mapping');

    const apiDeclarations = manifest.contributes?.api ?? [];
    expect(apiDeclarations.some((item) => item.path === '/models' && item.handler === 'getModels')).toBe(true);
  });
});
