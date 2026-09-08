import { expect, test } from 'bun:test';
import { sortBy } from 'lodash-es';
import { compile } from 'svelte/compiler';
import { cloneUpstreamDraft, duplicateEditorUpstream, hasInvalidManagedBinding } from '$api/config-adapters';

const source = await Bun.file(new URL('./UpstreamsSection.svelte', import.meta.url)).text();
const names = ['groupUpstreams', 'flattenGroups', 'openUpstreamModal', 'closeUpstreamModal', 'saveUpstream',
  'removeUpstream', 'duplicateUpstream', 'toggleUpstreamStatus', 'handleMerge', 'handleCreatePriority', 'onUpdateWeight'];
const functions = names.map(name => source.match(new RegExp(`  function ${name}\\([\\s\\S]*?\\n  }`))![0]).join('\n');
// Execute production projection and mutation handlers, preserving their original-index mapping.
const create = (endpoints = initial()) => new Function('initial', 'sortBy', 'cloneUpstreamDraft', 'duplicateEditorUpstream', 'hasInvalidManagedBinding', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const route = { endpoints: structuredClone(initial) }, uuidv4 = () => 'copy', $_ = key => key;
  let showUpstreamModal = false, editingUpstreamIndex = -1, editingUpstream, isEditingUpstreamValid = true;
  let alerts = 0; const alert = () => alerts++;
  ${functions}
  return { route, groupUpstreams, handleMerge, handleCreatePriority, onUpdateWeight, toggleUpstreamStatus,
    openUpstreamModal, saveUpstream, duplicateUpstream, removeUpstream,
    get editing() { return editingUpstream }, get alerts() { return alerts } };
`))(endpoints, sortBy, cloneUpstreamDraft, duplicateEditorUpstream, hasInvalidManagedBinding);
const initial = () => [
  { _uid: 'hidden', target: 'https://hidden.test', description: 'private', priority: 1, weight: 100 },
  { _uid: 'visible', target: 'https://ALPHA.test', description: 'Primary Pool', priority: 5, weight: 20 },
  { _uid: 'other', target: 'https://other.test', description: 'Backup Pool', priority: 9, weight: 30 },
];
const drop = (originalIndex: number) => ({ preventDefault() {}, dataTransfer: { getData: () => JSON.stringify({ originalIndex }) } });

test('target/description search trims and ignores case; clearing restores every endpoint without mutation', () => {
  const model = create(), before = structuredClone(model.route.endpoints);
  for (const query of [' alpha ', 'PRIMARY pool']) {
    const groups = model.groupUpstreams(model.route.endpoints, query);
    expect(groups).toHaveLength(1);
    expect(groups[0].priority).toBe(5);
    expect(groups[0].groupIndex).toBe(1);
    expect(groups[0].upstreams.map((u: any) => u.originalIndex)).toEqual([1]);
  }
  expect(model.groupUpstreams(model.route.endpoints, 'no-match')).toEqual([]);
  expect(model.groupUpstreams(model.route.endpoints, '  ').flatMap((g: any) => g.upstreams.map((u: any) => u._uid))).toEqual(['hidden', 'visible', 'other']);
  expect(model.route.endpoints).toEqual(before);
});

test('filtered edit, weight, enable, copy and delete target the original endpoint only', () => {
  const model = create(), hidden = structuredClone(model.route.endpoints[0]);
  const index = model.groupUpstreams(model.route.endpoints, 'alpha')[0].upstreams[0].originalIndex;
  model.onUpdateWeight(index, 45);
  model.toggleUpstreamStatus(index);
  model.openUpstreamModal(index);
  expect(model.editing._uid).toBe('visible');
  expect(model.editing.weight).toBe(45);
  expect(model.editing.is_disabled).toBe(true);
  model.editing.description = 'edited'; model.saveUpstream();
  model.duplicateUpstream(index);
  expect(model.route.endpoints[index + 1].description).toBe('edited');
  expect(model.route.endpoints[index + 1]._uid).not.toBe('visible');
  expect(model.route.endpoints[index + 1].target).toBe('https://ALPHA.test-copy');
  model.removeUpstream(index);
  expect(model.route.endpoints.some((u: any) => u._uid === 'visible')).toBe(false);
  expect(model.route.endpoints[0]).toEqual(hidden);
  const one = create(initial().slice(0, 1)); one.removeUpstream(0);
  expect(one.route.endpoints).toHaveLength(1); expect(one.alerts).toBe(1);
});

test('filtered merge uses the real target group, including non-contiguous priorities', () => {
  const model = create();
  const target = model.groupUpstreams(model.route.endpoints, 'backup')[0];
  model.handleMerge({ detail: { originalIndex: 1 } }, target.groupIndex);
  const groups = model.groupUpstreams(model.route.endpoints);
  expect(groups.map((g: any) => g.upstreams.map((u: any) => u._uid))).toEqual([['hidden'], ['visible', 'other']]);
});

test('filtered spacer drop uses full-list boundaries after removing the dragged group', () => {
  const model = create();
  const target = model.groupUpstreams(model.route.endpoints, 'backup')[0];
  model.handleCreatePriority(drop(1), target.groupIndex);
  expect(model.route.endpoints.map((u: any) => u._uid)).toEqual(['hidden', 'visible', 'other']);
  expect(model.route.endpoints.map((u: any) => u.priority)).toEqual([1, 2, 3]);
});

test('dropping after a filtered target keeps hidden members and full-list order', () => {
  const endpoints = initial(); endpoints[1].priority = 1;
  const model = create(endpoints);
  const target = model.groupUpstreams(model.route.endpoints, 'backup')[0];
  model.handleCreatePriority(drop(1), target.groupIndex + 1);
  expect(model.route.endpoints.map((u: any) => u._uid)).toEqual(['hidden', 'other', 'visible']);
  expect(model.route.endpoints.map((u: any) => u.priority)).toEqual([1, 2, 3]);
});

test('service has one flat endpoint panel while route retains its original shell', () => {
  expect(() => compile(source, { filename: 'UpstreamsSection.svelte' })).not.toThrow();
  const title = source.match(/title=\{(isService[^\n]+)\}/)![1];
  const list = source.match(/<div class=\{(isService \? 'flex flex-col gap-4[^\n]+)\}>/)![1];
  const render = (expression: string, isService: boolean) => new Function('isService', '$_', `return ${expression}`)(isService, (key: string) => key);
  expect(render(title, true)).toBe('serviceEditor.builder.endpoints');
  expect(render(title, false)).toBe('routeEditor.customEndpoints');
  expect(render(list, true)).toBe('flex flex-col gap-4 min-h-[120px]');
  expect(render(list, false)).toBe('flex flex-col gap-4 p-4 bg-carbon-950 border border-carbon-600 min-h-[120px]');
  expect(source).toContain('groupUpstreams(endpoints, upstreamSearchTerm)');
  expect(source).toContain('handleMerge(e, group.groupIndex)');
  expect(source).toContain('handleSpacerDrop(e, group.groupIndex + 1)');
  expect(source).toContain('serviceEditor.noMatchingEndpoints');
  expect(source).toContain('route-upstream-add-button');
});
