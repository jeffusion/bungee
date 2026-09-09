import { lstat, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { basename, extname, resolve } from 'node:path';
import * as ts from 'typescript';
import { hashRuntimeIdentity } from '../plugin-manifest-catalog/runtime-identity';
import type { PluginManifestRecord } from '../plugin-manifest-catalog/types';
import type { ControlPlugin } from './contracts';

type BuildInput = {
  readonly imports: readonly { readonly path: string; readonly external?: boolean; readonly original?: string; readonly kind?: string }[];
};

type BuildResult = {
  readonly success: boolean;
  readonly outputs?: readonly { readonly path: string; text(): Promise<string> }[];
  readonly metafile?: {
    readonly inputs: Record<string, BuildInput>;
    readonly outputs?: Record<string, { readonly entryPoint?: string }>;
  };
};

function isBuiltin(specifier: string): boolean {
  return /^(?:node|bun):/.test(specifier) || builtinModules.includes(specifier);
}

function loaderFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.ts': return 'ts';
    case '.tsx': return 'tsx';
    case '.jsx': return 'jsx';
    case '.json': return 'json';
    default: return 'js';
  }
}

function isStaticSpecifier(node: ts.Expression | undefined): boolean {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

function scriptKindFor(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case '.ts': return ts.ScriptKind.TS;
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    default: return ts.ScriptKind.JS;
  }
}

function rejectUnlockedDynamicLoads(content: Uint8Array, path: string): void {
  if (extname(path).toLowerCase() === '.json') return;
  const source = new TextDecoder().decode(content);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const aliases = new Set<string>(['require']);
  let changed = true;
  while (changed) {
    changed = false;
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const initializer = node.initializer;
        const alias = ts.isIdentifier(initializer) && aliases.has(initializer.text)
          || ts.isPropertyAccessExpression(initializer) && initializer.name.text === 'require';
        if (alias && !aliases.has(node.name.text)) { aliases.add(node.name.text); changed = true; }
      }
      ts.forEachChild(node, collect);
    };
    collect(file);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isDirectRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isRequireAlias = ts.isIdentifier(node.expression)
        && aliases.has(node.expression.text)
        && node.expression.text !== 'require';
      const isRequireProperty = ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'require';
      if (isRequireAlias || isRequireProperty || (isDynamicImport || isDirectRequire) && !isStaticSpecifier(node.arguments[0])) {
        throw new Error(`control artifact has an unlocked dynamic load in ${path}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

async function resolveDependencyFile(candidate: string): Promise<string | undefined> {
  for (const option of [candidate, `${candidate}.ts`, `${candidate}.js`, `${candidate}.mjs`, resolve(candidate, 'index.ts'), resolve(candidate, 'index.js')]) {
    try {
      if ((await lstat(option)).isFile()) return option;
    } catch { /* continue with the next conventional extension */ }
  }
  return undefined;
}

function runtimeHash(
  pluginPath: string,
  inputs: Record<string, BuildInput>,
  bytes: ReadonlyMap<string, Uint8Array>,
  allowRelativeExternal = false,
): `sha256:${string}` {
  const capturedInputs: { path: string; bytes: Uint8Array }[] = [];
  const externalDependencies = new Set<string>();
  for (const [input, metadata] of Object.entries(inputs).sort(([left], [right]) => left.localeCompare(right))) {
    for (const imported of metadata.imports) {
      const specifier = imported.original ?? imported.path;
      if (imported.kind === 'dynamic-import' && !isBuiltin(specifier)) {
        throw new Error(`control artifact has an unlocked dynamic import: ${specifier}`);
      }
      if (imported.external && !isBuiltin(specifier) && (!allowRelativeExternal || !specifier.startsWith('.'))) {
        throw new Error(`control artifact has an unlocked external import: ${specifier}`);
      }
      if (imported.external) externalDependencies.add(specifier);
    }
    const absolute = resolve(input);
    const content = bytes.get(absolute);
    if (content === undefined) throw new Error(`control artifact input was not captured: ${input}`);
    capturedInputs.push({ path: absolute, bytes: content });
  }
  return hashRuntimeIdentity(pluginPath, capturedInputs, externalDependencies);
}

export async function loadImmutableControlArtifact(record: PluginManifestRecord): Promise<ControlPlugin> {
  if (record.controlPath === undefined) throw new Error('control artifact is not declared');
  const build = Bun.build as unknown as (options: Record<string, unknown>) => Promise<BuildResult>;
  const buildInputs = async (
    entrypoints: readonly string[],
    snapshots: Map<string, Uint8Array>,
    enforceControlPolicy: boolean,
    resolveRelativeExternal: boolean,
  ): Promise<BuildResult> => {
    const pending = new Set(entrypoints);
    let result: BuildResult;
    while (true) {
      result = await build({
        entrypoints: [...pending],
        target: 'bun',
        format: 'esm',
        bundle: true,
        metafile: true,
        write: false,
        plugins: [{
          name: 'bungee-immutable-control-artifact',
          setup(builder: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<unknown>): void }) {
            builder.onLoad({ filter: /.*/ }, async ({ path }) => {
              const content = await readFile(path);
              if (enforceControlPolicy) rejectUnlockedDynamicLoads(content, path);
              snapshots.set(resolve(path), content);
              return { contents: content, loader: loaderFor(path) };
            });
          },
        }],
      });
      if (!result.success || result.metafile === undefined) break;
      let added = false;
      if (resolveRelativeExternal) {
        for (const [input, metadata] of Object.entries(result.metafile.inputs)) {
          for (const imported of metadata.imports) {
            const specifier = imported.original ?? imported.path;
            if (!imported.external || isBuiltin(specifier) || !specifier.startsWith('.')) continue;
            const candidate = await resolveDependencyFile(resolve(resolve(input), '..', specifier));
            if (candidate === undefined) throw new Error(`control artifact external import cannot be resolved: ${specifier}`);
            if (!pending.has(candidate)) { pending.add(candidate); added = true; }
          }
        }
      }
      if (!added) break;
    }
    return result;
  };

  const mainSnapshots = new Map<string, Uint8Array>();
  const mainResult = await buildInputs([record.mainPath], mainSnapshots, false, true);
  if (!mainResult.success || mainResult.metafile === undefined) {
    throw new Error('control artifact could not be loaded');
  }
  const controlSnapshots = new Map<string, Uint8Array>();
  const controlResult = await buildInputs([record.controlPath], controlSnapshots, true, false);
  if (!controlResult.success || controlResult.outputs === undefined || controlResult.metafile === undefined) {
    throw new Error('control artifact could not be loaded');
  }
  runtimeHash(record.pluginPath, mainResult.metafile.inputs, mainSnapshots, true);
  runtimeHash(record.pluginPath, controlResult.metafile.inputs, controlSnapshots);
  const inputs = { ...mainResult.metafile.inputs, ...controlResult.metafile.inputs };
  const snapshots = new Map([...mainSnapshots, ...controlSnapshots]);
  const digest = runtimeHash(record.pluginPath, inputs, snapshots, true);
  if (digest !== record.runtimeHash) throw new Error('control artifact does not match the catalog runtime identity');
  const controlEntry = resolve(record.controlPath);
  const controlOutput = controlResult.outputs.find((output) => {
    const entryPoint = controlResult.metafile?.outputs?.[output.path]?.entryPoint;
    return entryPoint !== undefined && resolve(entryPoint) === controlEntry;
  });
  if (controlOutput === undefined) throw new Error(`control artifact output is missing for ${basename(record.controlPath)}`);
  const source = await controlOutput.text();
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let module: { default?: unknown; createControl?: unknown };
  try {
    module = await import(moduleUrl) as { default?: unknown; createControl?: unknown };
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  const candidate = module.default ?? module;
  if (typeof candidate !== 'object' || candidate === null || typeof (candidate as ControlPlugin).createControl !== 'function') {
    throw new Error('control artifact does not export createControl');
  }
  return candidate as ControlPlugin;
}
