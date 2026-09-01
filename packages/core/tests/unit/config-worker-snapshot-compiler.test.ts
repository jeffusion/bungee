import { beforeAll, describe, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { createCatalogSnapshotCompiler } from '../../src/config-worker/snapshot-compiler';
import { hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { BUILTINS } from './plugin-manifest-catalog-fixtures';
import { PROCESS_IDENTITY } from './config-publication-worker-runtime.fixtures';

let catalog: PluginManifestCatalog;

beforeAll(async () => {
  catalog = await PluginManifestCatalog.build({ scanDirectories: [BUILTINS] });
});

function aggregate(overrides: Partial<ConfigurationAggregateV2> = {}): ConfigurationAggregateV2 {
  return {
    logical_configuration: { services: [], routes: [], plugins: [] },
    plugin_activations: [],
    ...overrides,
  };
}

function command(value: ConfigurationAggregateV2) {
  return {
    command: 'start-current-config-worker' as const,
    ...PROCESS_IDENTITY,
    revision: 1,
    content_hash: hashConfigurationContent(value),
    plugin_catalog_hash: catalog.hash,
    aggregate: value,
    activated_plugin_names: Object.freeze(value.plugin_activations.map(({ plugin_name }) => plugin_name)),
    publication: null,
  };
}

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  await promise.then(
    () => { throw new Error('expected compilation to fail'); },
    (error: unknown) => expect(String(error)).toContain(message),
  );
}

describe('config worker catalog snapshot compiler', () => {
  test('normalizes without mutating input and compiles the verified snapshot', async () => {
    const input = aggregate();
    const before = structuredClone(input);
    const compile = createCatalogSnapshotCompiler(async () => catalog);

    const result = await compile(command(input), command(input));

    expect(result.config.routes).toEqual([]);
    expect(input).toEqual(before);
  });

  test('rejects catalog mismatch before runtime compilation', async () => {
    const input = aggregate();
    const inputCommand = { ...command(input), plugin_catalog_hash: `sha256:${'0'.repeat(64)}` as const };
    await expectRejected(createCatalogSnapshotCompiler(async () => catalog)(inputCommand, inputCommand), 'catalog hash');
  });

  test('rejects unknown activation and invalid plugin options', async () => {
    const unknown = aggregate({ plugin_activations: [{ plugin_name: 'not-in-catalog' }] });
    const knownName = catalog.names()[0];
    if (knownName === undefined) throw new Error('catalog must not be empty');
    const invalid = aggregate({
      logical_configuration: {
        services: [], routes: [],
        plugins: [{
          id: '40000000-0000-4000-8000-000000000001',
          position: 1,
          name: knownName,
          enabled: true,
          options: { impossible_option: true },
        }],
      },
      plugin_activations: [{ plugin_name: knownName }],
    });

    await expectRejected(createCatalogSnapshotCompiler(async () => catalog)(command(unknown), command(unknown)), 'validation');
    await expectRejected(createCatalogSnapshotCompiler(async () => catalog)(command(invalid), command(invalid)), 'validation');
  });

  test('rejects content hash mismatch after normalization', async () => {
    const input = aggregate();
    const normalized = parseNormalizeCompileAggregate(input, catalog.toCompileOptions());
    if (!normalized.ok) throw new Error('empty aggregate must compile');
    const inputCommand = { ...command(input), content_hash: `sha256:${'f'.repeat(64)}` as const };

    await expectRejected(createCatalogSnapshotCompiler(async () => catalog)(inputCommand, inputCommand), 'content hash');
  });

  test('rejects activated plugin metadata that differs from the aggregate without hashing metadata', async () => {
    const knownName = catalog.names()[0];
    if (knownName === undefined) throw new Error('catalog must not be empty');
    const input = aggregate({ plugin_activations: [{ plugin_name: knownName }] });
    const validCommand = command(input);
    const mismatchedCommand = { ...validCommand, activated_plugin_names: [] };

    expect(mismatchedCommand.content_hash).toBe(validCommand.content_hash);
    await expectRejected(
      createCatalogSnapshotCompiler(async () => catalog)(mismatchedCommand, mismatchedCommand),
      'activated plugin names',
    );
  });

  test('loads the catalog lazily once across compile attempts', async () => {
    let loads = 0;
    const compile = createCatalogSnapshotCompiler(async () => {
      loads += 1;
      return catalog;
    });
    const input = aggregate();

    await compile(command(input), command(input));
    await compile(command(input), command(input));

    expect(loads).toBe(1);
  });

  test('caches a loader that throws before returning its promise', async () => {
    let loads = 0;
    const compile = createCatalogSnapshotCompiler(() => {
      loads += 1;
      throw new Error('catalog load failed');
    });
    const input = command(aggregate());

    await expectRejected(compile(input, input), 'catalog load failed');
    await expectRejected(compile(input, input), 'catalog load failed');

    expect(loads).toBe(1);
  });
});
