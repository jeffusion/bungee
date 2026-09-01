import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { ConfigRepository, ConfigRepositoryError } from '../../src/config-storage';

const roots: string[] = [];
const repositories: ConfigRepository[] = [];

function open(): ConfigRepository {
  const root = mkdtempSync(join(tmpdir(), 'bungee-command-snapshot-'));
  roots.push(root);
  const repository = ConfigRepository.open(join(root, 'config.db'));
  repositories.push(repository);
  return repository;
}

function aggregate(): ConfigurationAggregateV2 {
  return {
    logical_configuration: {
      auth: { enabled: true, tokens: ['literal'] }, services: [], routes: [], plugins: [],
    },
    plugin_activations: [],
  };
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ConfigRepository immutable command boundary', () => {
  test('rejects accessor envelope fields without invoking getters', () => {
    // Given
    let reads = 0;
    const base = {
      mutation_id: 'accessor', expected_revision: 1, aggregate: aggregate(), kind: 'config',
      created_at: 1_700_000_000_000, target_worker_slots: [0],
    };

    // When / Then
    for (const field of Object.keys(base)) {
      const command = { ...base };
      const value = Reflect.get(base, field);
      Object.defineProperty(command, field, {
        enumerable: true, get() { reads += 1; return value; },
      });
      const repository = open();
      expect(() => Reflect.apply(repository.commit, repository, [command])).toThrow(ConfigRepositoryError);
    }
    expect(reads).toBe(0);
  });

  test('rejects nested aggregate and target element accessors without invoking getters', () => {
    // Given
    let reads = 0;
    const aggregateWithAccessor = Object.defineProperty({}, 'logical_configuration', {
      enumerable: true, get() { reads += 1; return {}; },
    });
    const targetWithAccessor = Object.defineProperty([], '0', {
      enumerable: true, configurable: true, get() { reads += 1; return 0; },
    });
    Object.defineProperty(targetWithAccessor, 'length', { value: 1 });
    const base = {
      mutation_id: 'nested-accessor', expected_revision: 1, aggregate: aggregate(), kind: 'config',
      created_at: 1_700_000_000_000, target_worker_slots: [0],
    };

    // When / Then
    for (const value of [
      { ...base, aggregate: aggregateWithAccessor },
      { ...base, target_worker_slots: targetWithAccessor },
    ]) {
      const repository = open();
      expect(() => Reflect.apply(repository.commit, repository, [value])).toThrow(ConfigRepositoryError);
    }
    expect(reads).toBe(0);
  });

  test('rejects symbol keys, exotic prototypes, proxies, revoked proxies, and sparse targets', () => {
    // Given
    const base = {
      mutation_id: 'invalid-shape', expected_revision: 1, aggregate: aggregate(), kind: 'config',
      created_at: 1_700_000_000_000, target_worker_slots: [0],
    };
    const symbolCommand = { ...base, [Symbol('hidden')]: true };
    const exotic = Object.assign(Object.create({ inherited: true }), base);
    const proxy = new Proxy(base, { ownKeys: () => ['mutation_id'] });
    const revoked = Proxy.revocable(base, {});
    revoked.revoke();
    const sparse = { ...base, target_worker_slots: Array.from({ length: 2 }) };
    const aggregateProxy = { ...base, aggregate: new Proxy(aggregate(), {}) };
    const exoticAggregate = { ...base, aggregate: Object.assign(Object.create({ inherited: true }), aggregate()) };
    const symbolAggregate = { ...base, aggregate: { ...aggregate(), [Symbol('hidden')]: true } };
    const targetProxy = { ...base, target_worker_slots: new Proxy([0], {}) };
    const targetWithSymbol = { ...base, target_worker_slots: Object.assign([0], { [Symbol('hidden')]: true }) };

    // When / Then
    for (const value of [
      symbolCommand, exotic, proxy, revoked.proxy, sparse, aggregateProxy, exoticAggregate,
      symbolAggregate, targetProxy, targetWithSymbol,
    ]) {
      const repository = open();
      expect(() => Reflect.apply(repository.commit, repository, [value])).toThrow(ConfigRepositoryError);
    }
  });

});
