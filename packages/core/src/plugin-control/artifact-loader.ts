import { readFile } from 'node:fs/promises';
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

function runtimeHash(
  pluginPath: string,
  inputs: Record<string, BuildInput>,
  bytes: ReadonlyMap<string, Uint8Array>,
): `sha256:${string}` {
  const capturedInputs: { path: string; bytes: Uint8Array }[] = [];
  const externalDependencies = new Set<string>();
  for (const [input, metadata] of Object.entries(inputs).sort(([left], [right]) => left.localeCompare(right))) {
    for (const imported of metadata.imports) {
      const specifier = imported.original ?? imported.path;
      if (imported.kind === 'dynamic-import' && !isBuiltin(specifier)) {
        throw new Error(`control artifact has an unlocked dynamic import: ${specifier}`);
      }
      if (imported.external && !isBuiltin(specifier)) {
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
  const snapshots = new Map<string, Uint8Array>();
  const build = Bun.build as unknown as (options: Record<string, unknown>) => Promise<BuildResult>;
  const result = await build({
    entrypoints: [record.mainPath, record.controlPath],
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
          rejectUnlockedDynamicLoads(content, path);
          snapshots.set(resolve(path), content);
          return { contents: content, loader: loaderFor(path) };
        });
      },
    }],
  });
  if (!result.success || result.outputs === undefined || result.metafile === undefined) {
    throw new Error('control artifact could not be loaded');
  }
  const digest = runtimeHash(record.pluginPath, result.metafile.inputs, snapshots);
  if (digest !== record.runtimeHash) throw new Error('control artifact does not match the catalog runtime identity');
  const controlEntry = resolve(record.controlPath);
  const controlOutput = result.outputs.find((output) => {
    const entryPoint = result.metafile?.outputs?.[output.path]?.entryPoint;
    return entryPoint !== undefined && resolve(entryPoint) === controlEntry;
  });
  if (controlOutput === undefined) throw new Error(`control artifact output is missing for ${basename(record.controlPath)}`);
  const source = await controlOutput.text();
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as {
    default?: unknown;
    createControl?: unknown;
  };
  const candidate = module.default ?? module;
  if (typeof candidate !== 'object' || candidate === null || typeof (candidate as ControlPlugin).createControl !== 'function') {
    throw new Error('control artifact does not export createControl');
  }
  return candidate as ControlPlugin;
}
