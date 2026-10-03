import { validateEngineRange } from './plugin-manifest-catalog/manifest-semver';
import { PluginManifestCatalogError } from './plugin-manifest-catalog/parse-utils';
import type { PluginServiceDeclarations } from './plugin-services';

export interface PluginDependencyManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly services?: PluginServiceDeclarations;
  readonly runtimeScope?: 'global' | 'scoped';
}

/** Immutable, validated required-dependency graph. Providers precede consumers. */
export class PluginDependencyGraph {
  readonly #dependencies: ReadonlyMap<string, readonly string[]>;
  readonly #declarations: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly #order: readonly string[];
  readonly #services: ReadonlyMap<string, PluginServiceDeclarations>;

  constructor(manifests: Iterable<PluginDependencyManifest>) {
    const records = new Map(Array.from(manifests, manifest => [manifest.name, manifest]));
    const dependencies = new Map<string, readonly string[]>();
    for (const [name, manifest] of records) {
      if (manifest.services?.provides?.length && manifest.runtimeScope !== 'global') throw new PluginManifestCatalogError(`${name}.services`, 'service providers must be global');
      for (const consumption of manifest.services?.consumes ?? []) {
        const provider = records.get(consumption.plugin);
        if (!Object.hasOwn(manifest.dependencies ?? {}, consumption.plugin)) throw new PluginManifestCatalogError(`${name}.services`, `service provider must be a declared dependency: ${consumption.plugin}`);
        if (!provider?.services?.provides?.some(value => value.id === consumption.id && value.version === consumption.version && value.process === consumption.process)) throw new PluginManifestCatalogError(`${name}.services`, `service contract unavailable: ${consumption.plugin}/${consumption.id}@${consumption.version}`);
      }
      const names = Object.keys(manifest.dependencies ?? {}).sort();
      for (const dependency of names) {
        const path = `${name}.dependencies.${dependency}`;
        const provider = records.get(dependency);
        if (!provider) throw new PluginManifestCatalogError(path, `missing required plugin: ${name} -> ${dependency}`);
        const range = manifest.dependencies![dependency]!;
        try {
          validateEngineRange(range, path, provider.version);
        } catch {
          throw new PluginManifestCatalogError(path, `dependency version mismatch or invalid range: ${name} -> ${dependency}; ${provider.version} does not satisfy ${range}`);
        }
      }
      dependencies.set(name, Object.freeze(names));
    }
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (name: string, path: readonly string[]): void => {
      if (visiting.has(name)) {
        throw new PluginManifestCatalogError(`${name}.dependencies`, `dependency cycle: ${[...path, name].join(' -> ')}`);
      }
      if (visited.has(name)) return;
      visiting.add(name);
      for (const dependency of dependencies.get(name) ?? []) visit(dependency, [...path, name]);
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };
    for (const name of [...records.keys()].sort()) visit(name, []);
    this.#declarations = new Map([...records].map(([name, manifest]) =>
      [name, Object.freeze({ ...manifest.dependencies })]));
    this.#dependencies = dependencies;
    this.#order = Object.freeze(order);
    this.#services = new Map([...records].map(([name, manifest]) => [name, manifest.services ?? {}]));
    Object.freeze(this);
  }

  declarations(): ReadonlyMap<string, Readonly<Record<string, string>>> {
    return new Map(this.#declarations);
  }
  serviceDeclarations(): ReadonlyMap<string, PluginServiceDeclarations> { return new Map(this.#services); }

  dependenciesOf(name: string): readonly string[] {
    const dependencies = this.#dependencies.get(name);
    if (!dependencies) throw new PluginManifestCatalogError(name, 'plugin is not present in the dependency catalog');
    return dependencies;
  }

  closure(names: Iterable<string>): readonly string[] {
    const selected = new Set<string>();
    const visit = (name: string): void => {
      if (selected.has(name)) return;
      const dependencies = this.dependenciesOf(name);
      selected.add(name);
      for (const dependency of dependencies) visit(dependency);
    };
    for (const name of names) visit(name);
    return Object.freeze(this.#order.filter(name => selected.has(name)));
  }

  /** Paths only from activated consumers; installed but inactive consumers never block disable. */
  dependentPaths(provider: string, activated: Iterable<string>): readonly (readonly string[])[] {
    const paths: string[][] = [];
    const search = (name: string, path: string[], visited: Set<string>): boolean => {
      if (visited.has(name)) return false;
      visited.add(name);
      if (name === provider) { paths.push(path); return true; }
      for (const dependency of this.dependenciesOf(name)) {
        if (search(dependency, [...path, dependency], visited)) return true;
      }
      return false;
    };
    for (const name of [...new Set(activated)].sort()) {
      if (name !== provider) search(name, [name], new Set());
    }
    return paths;
  }

  assertClosed(activated: Iterable<string>): void {
    const active = new Set(activated);
    const visited = new Set<string>();
    for (const name of active) {
      const visit = (consumer: string, path: string[]): void => {
        if (visited.has(consumer)) return;
        visited.add(consumer);
        for (const dependency of this.dependenciesOf(consumer)) {
          const nextPath = [...path, dependency];
          if (!active.has(dependency)) {
            throw new PluginManifestCatalogError('plugin_activations', `required dependency is not activated: ${nextPath.join(' -> ')}`);
          }
          visit(dependency, nextPath);
        }
      };
      visit(name, [name]);
    }
  }
}

export function updatePluginActivations(
  graph: PluginDependencyGraph,
  activated: Iterable<string>,
  name: string,
  enable: boolean,
): readonly string[] {
  const active = new Set(activated);
  graph.dependenciesOf(name);
  if (enable) {
    for (const dependency of graph.closure([name])) active.add(dependency);
  } else {
    const paths = graph.dependentPaths(name, active);
    if (paths.length) throw new PluginManifestCatalogError(name, `plugin is required by active consumers: ${paths.map(path => path.join(' -> ')).join('; ')}`);
    active.delete(name);
  }
  graph.assertClosed(active);
  return [...active].sort();
}
