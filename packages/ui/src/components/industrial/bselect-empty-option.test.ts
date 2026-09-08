import { expect, test } from 'bun:test';

const source = await Bun.file(new URL('./BSelect.svelte', import.meta.url)).text();
const derived = (name: string) => {
  const expression = source.match(new RegExp(`let ${name} = \\$derived\\(([\\s\\S]*?)\\);`))?.[1];
  if (!expression) throw new Error(`Missing derived expression: ${name}`);
  return expression;
};
const functions = ['optionLabel', 'emit', 'clearSelection', 'selectCreatableItem', 'handleSingleChange', 'removeValue']
  .map((name) => {
    const fn = source.match(new RegExp(`\\tfunction ${name}\\([\\s\\S]*?\\n\\t}`))?.[0];
    if (!fn) throw new Error(`Missing component function: ${name}`);
    return fn;
  }).join('\n');

// Execute the component's real expressions and handlers, not a second copy of
// its selection rules. No DOM fixture or new test framework is needed.
const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  let { options, value = '', values = [], mode = 'single', multiple = false } = initial;
  let disabled = false, loading = false, hovering = true, allowClear = true;
  let searchText = '', open = false, inputEl;
  const calls = [];
  const onchange = next => calls.push(next), onChange = undefined;
  const isMultiple = ${derived('isMultiple')};
  ${functions}
  return {
    get selected() { return ${derived('selected')}; },
    get selectedValues() { return ${derived('selectedValues')}; },
    get showClear() { return Boolean(${derived('showClear')}); },
    get value() { return value; }, get values() { return values; }, calls,
    clearSelection, selectCreatableItem, handleSingleChange, removeValue,
  };
`);
const control = new Function('initial', body);
const event = { preventDefault() {}, stopPropagation() {} };
const all = { value: '', label: '全部类型 / All types' };
const final = { value: 'final', label: '最终请求 / Final' };

test('explicit empty option is a valid single value', () => {
  const field = control({ options: [all, final] });
  expect(field.selected).toEqual(all);
  expect(field.showClear).toBe(false);
});

test('clear resets to All with an empty option, otherwise to a true placeholder', () => {
  for (const options of [[all, final], [final]]) {
    const field = control({ options, value: 'final' });
    expect(field.showClear).toBe(true);
    field.clearSelection(event);
    expect(field.value).toBe('');
    expect(field.calls).toEqual(['']);
    expect(field.showClear).toBe(false);
    expect(field.selected).toEqual(options.includes(all) ? all : undefined);
  }
  expect(control({ options: [final] }).selected).toBeUndefined();
});

test('unmatched nonempty values and creatable selection retain fallback labels and callbacks', () => {
  const field = control({ options: [], value: 'loading-model-id' });
  expect(field.selected).toEqual({ value: 'loading-model-id', label: 'loading-model-id' });
  field.selectCreatableItem('custom-model');
  expect(field.selected).toEqual({ value: 'custom-model', label: 'custom-model' });
  expect(field.calls).toEqual(['custom-model']);
  field.handleSingleChange(final);
  expect(field.value).toBe('final');
  expect(field.calls).toEqual(['custom-model', 'final']);
});

test('multiple and tags still map, remove and clear their value arrays', () => {
  for (const mode of ['multiple', 'tags']) {
    const field = control({ options: [all, final], mode, values: ['', 'final'] });
    expect(field.selectedValues).toEqual([all, final]);
    expect(field.showClear).toBe(true);
    field.removeValue('');
    expect(field.values).toEqual(['final']);
    field.clearSelection(event);
    expect(field.values).toEqual([]);
    expect(field.calls).toEqual([['final'], []]);
    expect(field.showClear).toBe(false);
  }
});
