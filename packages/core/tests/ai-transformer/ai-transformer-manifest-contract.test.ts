import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type ManifestSchemaField = {
  name?: string;
};
type ManifestData = {
  configSchema?: ManifestSchemaField[];
  translations?: Record<string, Record<string, string>>;
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(currentDir, '../../../../plugins/ai-transformer/manifest.json');

async function loadManifest(): Promise<ManifestData> {
  return JSON.parse(await Bun.file(manifestPath).text()) as ManifestData;
}

describe('ai-transformer manifest contract', () => {
  test('should not expose removed threshold/token mapping config fields', async () => {
    const manifest = await loadManifest();
    const fieldNames = new Set((manifest.configSchema ?? []).map((field) => field.name).filter(Boolean));

    const removedFieldNames = [
      'anthropicMaxTokens',
      'geminiToOpenAILowReasoningThreshold',
      'geminiToOpenAIHighReasoningThreshold',
      'openAILowToAnthropicTokens',
      'openAIMediumToAnthropicTokens',
      'openAIHighToAnthropicTokens',
      'openAIXHighToAnthropicTokens',
      'openAILowToGeminiTokens',
      'openAIMediumToGeminiTokens',
      'openAIHighToGeminiTokens',
      'openAIXHighToGeminiTokens'
    ];

    for (const fieldName of removedFieldNames) {
      expect(fieldNames.has(fieldName)).toBe(false);
    }

    expect(fieldNames.has('transformation')).toBe(true);
    expect(fieldNames.has('modelMappings')).toBe(false);
    expect(fieldNames.has('anthropicToOpenAIApiMode')).toBe(true);
  });

  test('should not keep legacy reasoning mapping translation keys', async () => {
    const manifest = await loadManifest();
    const translationBundles = Object.values(manifest.translations ?? {});

    for (const bundle of translationBundles) {
      const keys = new Set(Object.keys(bundle));

      expect(Array.from(keys).some((key) => key.startsWith('g2oLowThreshold.'))).toBe(false);
      expect(Array.from(keys).some((key) => key.startsWith('g2oHighThreshold.'))).toBe(false);
      expect(Array.from(keys).some((key) => key.startsWith('o2aLowTokens.'))).toBe(false);
      expect(Array.from(keys).some((key) => key.startsWith('o2aMediumTokens.'))).toBe(false);
      expect(Array.from(keys).some((key) => key.startsWith('o2aHighTokens.'))).toBe(false);
      expect(Array.from(keys).some((key) => key.startsWith('o2aXhighTokens.'))).toBe(false);
      expect(Array.from(keys).some((key) => key.startsWith('o2gLowTokens.'))).toBe(false);
      expect(Array.from(keys).some((key) => key.startsWith('o2gMediumTokens.'))).toBe(false);
      expect(Array.from(keys).some((key) => key.startsWith('o2gHighTokens.'))).toBe(false);
      expect(Array.from(keys).some((key) => key.startsWith('o2gXhighTokens.'))).toBe(false);
      expect(keys.has('anthropicMaxTokens.label')).toBe(false);
      expect(keys.has('anthropicMaxTokens.description')).toBe(false);
    }
  });
});
