import { describe, expect, test } from 'bun:test';
import { buildCatalogIndex } from '../server/catalog';
import { CatalogView, capabilitiesServiceOf, reconcileCatalogView } from '../server/local';

function catalog(reasoningOptions?: unknown) {
  return { fixture: { name: 'Fixture', models: { model: {
    name: 'Model', reasoning: true, tool_call: true, limit: { context: 200000, output: 8000 },
    modalities: { input: ['text', 'image'] }, cost: { input: 1, output: 2 },
    ...(reasoningOptions === undefined ? {} : { reasoning_options: reasoningOptions }),
  } } } };
}

function snapshot(version: number, data: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify({ version, fetchedAt: 50, catalog: data }));
  return { bytes, descriptor: { owner: 'models-dev', epoch: 1, version, schemaVersion: 1,
    digest: 'sha256:fixture' as const, size: bytes.length, chunkBytes: 60000 } };
}

describe('models-dev snapshot capabilities', () => {
  test('does not infer controls from reasoning=true and keeps unrelated model data readable', () => {
    const view = new CatalogView(), service = capabilitiesServiceOf(view);
    expect(service.model({ provider: 'fixture', model: 'model' })).toBeNull();
    for (const [options, status] of [[undefined, 'missing'], [null, 'invalid'], [[], 'known']] as const) {
      view.apply(buildCatalogIndex({ version: 1, fetchedAt: 50, catalog: catalog(options) }));
      expect(service.model({ provider: 'fixture', model: 'model' })).toEqual({
        provider: 'fixture', model: 'model', name: 'Model', contextWindow: 200000, outputLimit: 8000,
        toolCall: true, reasoning: true, inputModalities: ['text', 'image'], catalogVersion: 1,
        reasoningOptions: status === 'known' ? [] : null, reasoningOptionsStatus: status,
      });
      expect(view.resolveModel({ pricingProvider: 'fixture', model: 'model' })).toMatchObject({ input: 1, output: 2 });
      expect(view.modelOptions().total).toBe(1);
    }
    expect(service.model({ provider: 'fixture', model: 'missing' })).toBeNull();
  });

  test('replaces controls and model fields with one snapshot version, retaining prior reads', () => {
    const view = new CatalogView(), service = capabilitiesServiceOf(view);
    expect(reconcileCatalogView(snapshot(1, catalog([{ type: 'toggle' }])), view)).toBe('applied');
    const prior = service.model({ provider: 'fixture', model: 'model' })!;
    const updated = catalog([{ type: 'budget_tokens', min: -1, max: 4096 }]);
    updated.fixture.models.model.name = 'Updated'; updated.fixture.models.model.limit.context = 300000;
    expect(reconcileCatalogView(snapshot(2, updated), view)).toBe('applied');
    expect(service.model({ provider: 'fixture', model: 'model' })).toMatchObject({
      name: 'Updated', contextWindow: 300000, catalogVersion: 2,
      reasoningOptions: [{ type: 'budget_tokens', min: -1, max: 4096 }], reasoningOptionsStatus: 'known',
    });
    expect(prior).toMatchObject({ name: 'Model', contextWindow: 200000, catalogVersion: 1, reasoningOptions: [{ type: 'toggle' }] });
    expect(service.status().version).toBe(2);
    const corrupt = snapshot(3, catalog([])); corrupt.descriptor.version = 4;
    expect(reconcileCatalogView(corrupt, view)).toBe('failed');
    expect(service.model({ provider: 'fixture', model: 'model' })?.catalogVersion).toBe(2);
  });

  test('an invalid reasoning option isolates diagnostics and does not reject a complete catalog', () => {
    const view = new CatalogView(), service = capabilitiesServiceOf(view);
    const data = catalog([{ type: 'effort', values: ['credential-placeholder'] }]);
    expect(reconcileCatalogView(snapshot(3, data), view)).toBe('applied');
    const result = service.model({ provider: 'fixture', model: 'model' });
    expect(result).toMatchObject({ reasoningOptions: null, reasoningOptionsStatus: 'invalid', catalogVersion: 3 });
    expect(JSON.stringify(result)).not.toContain('credential-placeholder');
    expect(service.status()).toMatchObject({ state: 'ready', error: null });
  });
});
