import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';

const source = await Bun.file(new URL('./PluginEditor.svelte', import.meta.url)).text();
const handlers = ['isProtected', 'handleEditPlugin', 'handleRemovePlugin', 'handleSavePlugin', 'handleCancelDialog']
  .map(name => source.match(new RegExp(`  function ${name}\\([\\s\\S]*?\\n  }`))![0]).join('\n');
function create(protectedBindingIds: string[] = []) {
  return new Function('protectedBindingIds', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
    let plugins = [{ _uid: 'owner', _position: 4, name: 'missing-plugin', enabled: false,
      options: { accountRef: 'account', unknown: { nested: [1, 2] }, visible: 'before' } }];
    let showAddDialog = false, selectedPluginName = null, editingPluginIndex = null;
    let pluginConfig = {}, configErrors = {}, changes = 0;
    const availablePlugins = [], dispatch = () => changes++;
    ${handlers}
    return { handleEditPlugin, handleRemovePlugin, handleSavePlugin, handleCancelDialog,
      get plugins() { return plugins; }, get config() { return pluginConfig; },
      set config(value) { pluginConfig = value; }, get changes() { return changes; } };
  `))(protectedBindingIds);
}

test('protected binding cannot be edited or removed by ordinary plugin handlers', () => {
  const editor = create(['owner']), before = structuredClone(editor.plugins);
  editor.handleEditPlugin(0);
  editor.handleRemovePlugin(0);
  editor.handleSavePlugin();
  expect(editor.plugins).toEqual(before);
  expect(editor.changes).toBe(0);
  expect(source.match(/disabled=\{isProtected\(index\)\}/g)).toHaveLength(2);
  expect(() => compile(source, { filename: 'PluginEditor.svelte' })).not.toThrow();
});

test('ordinary editing retains binding identity, disabled state and unknown options', () => {
  const editor = create();
  editor.handleEditPlugin(0);
  editor.config = { visible: 'after' };
  editor.handleSavePlugin();
  expect(editor.plugins[0]).toEqual({ _uid: 'owner', _position: 4, name: 'missing-plugin', enabled: false,
    options: { accountRef: 'account', unknown: { nested: [1, 2] }, visible: 'after' } });
});

test('cancelling nested plugin edits preserves original options', () => {
  const editor = create(), before = structuredClone(editor.plugins);
  editor.handleEditPlugin(0);
  editor.config.unknown.nested.push(3);
  editor.handleCancelDialog();
  expect(editor.plugins).toEqual(before);
  expect(editor.changes).toBe(0);
});
