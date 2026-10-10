import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { uiImports, uiScripts } from '../helpers/ui-source';

const workspace = resolve(import.meta.dir, '../../../..');
const uiRoot = resolve(workspace, 'packages/ui/src');
const roots = [uiRoot, ...readdirSync(resolve(workspace, 'plugins'), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => resolve(workspace, 'plugins', entry.name, 'ui'))];
function files(directory: string): string[] {
  try { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? files(file) : /\.(svelte|[cm]?[jt]s)$/.test(file) ? [file] : [];
  }); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
}
const sources = roots.flatMap(files);
function dependencyFindings(file: string, source: string) {
  return uiImports(source, file).filter(specifier => {
    if (specifier === 'bits-ui' || specifier.startsWith('bits-ui/')) return !relative(uiRoot, file).replaceAll('\\', '/').startsWith('components/ui/');
    if (/(?:^|\/)components\/(?:common|compat|legacy|form|controls|smart-input|sections|model-mapping)(?:\/|$)/.test(specifier)) return true;
    return relative(uiRoot, file).replaceAll('\\', '/').startsWith('components/ui/')
      && /(?:^\$(?:api|stores)(?:\/|$)|\/domain\/|@plugins\/)/.test(specifier);
  });
}

test('UI primitives own Bits imports and remain independent of business layers', () => {
  for (const file of sources) expect(dependencyFindings(file, readFileSync(file, 'utf8')), relative(workspace, file)).toEqual([]);
});
test('dependency checks inspect actual imports, including dynamic imports and exports', () => {
  const file = resolve(uiRoot, 'routes/Example.svelte');
  expect(dependencyFindings(file, '<script>const example = "bits-ui"; // import "bits-ui";\n</script><p>bits-ui</p>')).toEqual([]);
  for (const script of ['import { Button } from "bits-ui";', 'export * from "bits-ui";', 'import("bits-ui");'])
    expect(dependencyFindings(file, `<script>${script}</script>`)).toEqual(['bits-ui']);
});

function calls(node: ts.Node, name: string): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) return true;
  let found = false;
  ts.forEachChild(node, child => { if (calls(child, name)) found = true; });
  return found;
}
function identifier(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;
  let found = false;
  ts.forEachChild(node, child => { if (identifier(child, name)) found = true; });
  return found;
}
function unsafeReactiveTranslation(source: string, file: string): boolean {
  let unsafe = false;
  function visit(node: ts.Node) {
    if (ts.isLabeledStatement(node) && node.label.text === '$' && calls(node.statement, '$_') && !identifier(node.statement, '$isLoading')) unsafe = true;
    ts.forEachChild(node, visit);
  }
  uiScripts(source, file).forEach(visit);
  return unsafe;
}
test('reactive translation syntax ignores comments and recognizes the loading guard', () => {
  const file = 'Example.svelte';
  expect(unsafeReactiveTranslation('<script>$: value = $_("label");</script>', file)).toBe(true);
  expect(unsafeReactiveTranslation('<script>$: value = $isLoading ? "" : $_("label");</script>', file)).toBe(false);
  expect(unsafeReactiveTranslation('<script>$: value = "$_()"; // $isLoading\n</script>', file)).toBe(false);
});

test('existing reactive translation boundaries remain closed without new exceptions', () => {
    const allowlist = [
      'packages/ui/src/routes/Dashboard.svelte',
      'packages/ui/src/routes/ServiceEditor.svelte',
      'packages/ui/src/routes/RoutesIndex.svelte',
      'packages/ui/src/routes/ServicesIndex.svelte',
      'packages/ui/src/routes/Plugins.svelte',
      'packages/ui/src/routes/RouteEditor.svelte',
      'packages/ui/src/routes/Configuration.svelte',
      'packages/ui/src/components/AuthEditor.svelte',
      'packages/ui/src/components/EndpointQuickPreview.svelte',
      'packages/ui/src/components/ModelMappingEditor.svelte',
      'packages/ui/src/components/domain/route/HeadersEditor.svelte',
      'packages/ui/src/components/domain/route/QueryEditor.svelte',
      'packages/ui/src/components/PluginEditor.svelte',
      'packages/ui/src/components/PluginConfigDisplay.svelte',
      'packages/ui/src/components/LoggingEditor.svelte',
      'packages/ui/src/components/LogDetailModal.svelte',
      'packages/ui/src/components/DynamicPluginForm.svelte',
      'packages/ui/src/components/domain/route/sections/DirectResponseSection.svelte',
      'packages/ui/src/components/FailoverEditor.svelte',
      'packages/ui/src/components/ModelMappingCatalogManager.svelte',
      'packages/ui/src/components/domain/service/LoadBalancingSection.svelte',
      'packages/ui/src/components/domain/route/UpstreamForm.svelte',
      'packages/ui/src/components/shell/ConfirmDialog.svelte',
      'packages/ui/src/components/domain/route/sections/PreviewSection.svelte',
      'packages/ui/src/components/domain/route/sections/UpstreamTargetSection.svelte',
      'packages/ui/src/components/domain/route/BodyEditor.svelte',
      'packages/ui/src/components/domain/route/sections/UpstreamsSection.svelte',
      'packages/ui/src/components/domain/route/sections/RetrySection.svelte',
      'packages/ui/src/components/domain/route/sections/ModificationSection.svelte',
      'packages/ui/src/components/domain/route/sections/CorsSection.svelte',
      'packages/ui/src/components/domain/route/sections/FailoverSection.svelte',
      'packages/ui/src/components/domain/route/sections/BasicInfoSection.svelte',
      'packages/ui/src/components/domain/route/sections/RateLimitSection.svelte',
      'plugins/token-stats/ui/TokenStatsChart.svelte',
    ].map((p) => resolve(workspace, p));

  for (const file of sources.filter(file => file.endsWith('.svelte'))) {
    if (unsafeReactiveTranslation(readFileSync(file, 'utf8'), file)) expect(allowlist, relative(workspace, file)).toContain(file);
  }
});
