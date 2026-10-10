import { lstat, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { basename, dirname, extname, resolve } from 'node:path';
import * as ts from 'typescript';
import { resolveMetafileInputPath } from '../plugin-manifest-catalog/manifest-filesystem';
import { externalRuntimeDependencyIdentity, hashRuntimeIdentity, pluginRuntimeBuildSource } from '../plugin-manifest-catalog/runtime-identity';
import type { PluginManifestRecord } from '../plugin-manifest-catalog/types';
import type { ControlPlugin } from './contracts';

type BuildInput = {
  readonly imports: readonly { readonly path: string; readonly external?: boolean; readonly original?: string; readonly kind?: string }[];
};

type BuildResult = {
  readonly success: boolean;
  readonly outputs?: readonly { readonly path: string; readonly kind: 'entry-point' | 'chunk' | 'asset'; text(): Promise<string> }[];
  readonly metafile?: {
    readonly inputs: Record<string, BuildInput>;
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

function resolveCapturedInput(
  input: string,
  absWorkingDirectory: string,
  bytes: ReadonlyMap<string, Uint8Array>,
): string {
  const candidate = resolveMetafileInputPath(input, absWorkingDirectory);
  if (bytes.has(candidate)) return candidate;
  const suffix = input.replaceAll('\\', '/').replace(/^(?:\.\.\/)+/, '');
  const matches = [...bytes.keys()].filter((path) => path.replaceAll('\\', '/') === suffix || path.replaceAll('\\', '/').endsWith(`/${suffix}`));
  if (matches.length > 1) throw new Error(`ambiguous metafile input: ${input}`);
  return matches[0] ?? candidate;
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
  const unwrap = (expression: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression)) expression = expression.expression;
    return expression;
  };
  const isRequireProperty = (expression: ts.Expression): boolean => {
    const value = unwrap(expression);
    return ts.isPropertyAccessExpression(value) && value.name.text === 'require'
      || ts.isElementAccessExpression(value) && isStaticSpecifier(value.argumentExpression)
        && (value.argumentExpression as ts.StringLiteral).text === 'require';
  };
  const isRequireReference = (expression: ts.Expression): boolean => {
    const value = unwrap(expression);
    return ts.isIdentifier(value) && aliases.has(value.text) || isRequireProperty(value);
  };
  let changed = true;
  while (changed) {
    changed = false;
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
        for (const binding of node.name.elements) {
          const property = binding.propertyName ?? binding.name;
          if ((ts.isIdentifier(property) || ts.isStringLiteral(property)) && property.text === 'require'
            && ts.isIdentifier(binding.name) && !aliases.has(binding.name.text)) {
            aliases.add(binding.name.text); changed = true;
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const alias = isRequireReference(node.initializer);
        if (alias && !aliases.has(node.name.text)) { aliases.add(node.name.text); changed = true; }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left) && isRequireReference(node.right) && !aliases.has(node.left.text)) {
        aliases.add(node.left.text); changed = true;
      }
      ts.forEachChild(node, collect);
    };
    collect(file);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const callee = unwrap(node.expression);
      const requireMethod = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) && isStaticSpecifier(callee.argumentExpression)
          ? (callee.argumentExpression as ts.StringLiteral).text : null;
      if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
        && isRequireReference(callee.expression)
        && (requireMethod === null || ['call', 'apply', 'bind'].includes(requireMethod))) {
        throw new Error(`control artifact has an unlocked dynamic load in ${path}`);
      }
      const isDirectRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isAliasedRequire = isRequireReference(callee) && !isDirectRequire;
      const specifier = node.arguments[0];
      // Bun's generated import.meta.require alias is invisible to its metafile.
      // Only literal builtins may bypass the bundler's dependency capture.
      if ((isDynamicImport || isDirectRequire || isAliasedRequire) && !isStaticSpecifier(specifier)
        || isAliasedRequire && !isBuiltin((specifier as ts.StringLiteral).text)) {
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
  absWorkingDirectory: string,
  allowRelativeExternal = false,
): `sha256:${string}` {
  const capturedInputs: { path: string; bytes: Uint8Array }[] = [];
  const externalDependencies = new Set<string>();
  for (const [input, metadata] of Object.entries(inputs).sort(([left], [right]) => left.localeCompare(right))) {
    for (const imported of metadata.imports) {
      const specifier = imported.original ?? imported.path;
      if (imported.kind === 'dynamic-import' && !isBuiltin(imported.path)) {
        throw new Error(`control artifact has an unlocked dynamic import: ${specifier}`);
      }
      if (imported.external && !isBuiltin(imported.path) && (!allowRelativeExternal || !specifier.startsWith('.'))) {
        throw new Error(`control artifact has an unlocked external import: ${specifier}`);
      }
      if (imported.external) externalDependencies.add(externalRuntimeDependencyIdentity(imported));
    }
    const absolute = resolveCapturedInput(input, absWorkingDirectory, bytes);
    const content = bytes.get(absolute);
    if (content === undefined) throw new Error(`control artifact input was not captured: ${input}`);
    capturedInputs.push({ path: absolute, bytes: content });
  }
  return hashRuntimeIdentity(pluginPath, capturedInputs, externalDependencies);
}

export async function loadImmutableControlArtifact(record: PluginManifestRecord): Promise<ControlPlugin> {
  if (record.controlPath === undefined) throw new Error('control artifact is not declared');
  const build = Bun.build as unknown as (options: Record<string, unknown>) => Promise<BuildResult>;
  const absWorkingDirectory = record.pluginPath;
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
        absWorkingDirectory,
        plugins: [{
          name: 'bungee-immutable-control-artifact',
          setup(builder: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<unknown>): void }) {
            builder.onLoad({ filter: /.*/ }, async ({ path }) => {
              const content = await readFile(path);
              const buildSource = pluginRuntimeBuildSource(path);
              if (enforceControlPolicy) rejectUnlockedDynamicLoads(buildSource === undefined ? content : new TextEncoder().encode(buildSource), path);
              snapshots.set(resolveMetafileInputPath(path, absWorkingDirectory), content);
              return { contents: buildSource ?? content, loader: loaderFor(path) };
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
            if (!imported.external || isBuiltin(imported.path) || !specifier.startsWith('.')) continue;
            const inputPath = resolveCapturedInput(input, absWorkingDirectory, snapshots);
            const candidate = await resolveDependencyFile(resolveMetafileInputPath(specifier, dirname(inputPath)));
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
  runtimeHash(record.pluginPath, mainResult.metafile.inputs, mainSnapshots, absWorkingDirectory, true);
  runtimeHash(record.pluginPath, controlResult.metafile.inputs, controlSnapshots, absWorkingDirectory);
  const ingressSnapshots = new Map<string, Uint8Array>();
  const ingressResult = record.ingressPath ? await buildInputs([record.ingressPath], ingressSnapshots, false, true) : undefined;
  if (ingressResult && (!ingressResult.success || !ingressResult.metafile)) throw new Error('ingress artifact could not be loaded');
  const inputs = { ...mainResult.metafile.inputs, ...controlResult.metafile.inputs, ...ingressResult?.metafile?.inputs };
  const snapshots = new Map([...mainSnapshots, ...controlSnapshots, ...ingressSnapshots]);
  const digest = runtimeHash(record.pluginPath, inputs, snapshots, absWorkingDirectory, true);
  if (digest !== record.runtimeHash) throw new Error('control artifact does not match the catalog runtime identity');
  const controlOutputs = controlResult.outputs.filter((output) => output.kind === 'entry-point');
  if (controlOutputs.length !== 1) {
    throw new Error(`control artifact output is not unique for ${basename(record.controlPath)}`);
  }
  const controlOutput = controlOutputs[0]!;
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
