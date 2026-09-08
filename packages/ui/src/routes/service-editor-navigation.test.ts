import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';

const source = await Bun.file(new URL('./ServiceEditor.svelte', import.meta.url)).text();
const nav = source.match(/navItems = [^?]+\? \[\] : \((\[[\s\S]*?\])\)\);/)![1];
const handler = source.match(/  function handleKeydown\([\s\S]*?\n  }/)![0];
// Execute the actual navigation definition and key handler, without a second mapping.
const create = new Function(new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const loading = false, $isLoading = false, service = { endpoints: [{}, {}], plugins: [{}] }, consumers = { count: 3 };
  const $_ = key => key, isModifierPressed = event => event.ctrlKey;
  const navItems = ${nav};
  let activeSection = 'identity', isValid = true, saving = false, saves = 0;
  const handleSave = () => saves++, handleCancel = () => {};
  ${handler}
  return { navItems, handleKeydown, get active() { return activeSection }, get saves() { return saves } };
`));
const order = ['identity', 'endpoints', 'transport', 'availability', 'plugins', 'consumers', 'review'];

test('seven service sections form one continuous ordered list without grouping metadata', () => {
  const { navItems } = create();
  expect(navItems.map((item: any) => item.id)).toEqual(order);
  expect(navItems.every((item: any) => !('group' in item))).toBe(true);
  expect(navItems.find((item: any) => item.id === 'endpoints').badge).toContain('2');
  expect(navItems.find((item: any) => item.id === 'consumers').badge).toContain('3');
});

test('modifier 1–7 follows visible navigation; typing in fields never switches sections', () => {
  const editor = create();
  const event = (key: string, inField = false, ctrlKey = true) => ({ key, ctrlKey, metaKey: false,
    altKey: false, target: { closest: () => inField ? {} : null }, preventDefault() {} });
  order.forEach((id, i) => { editor.handleKeydown(event(String(i + 1))); expect(editor.active).toBe(id); });
  for (let i = 1; i <= 7; i++) {
    editor.handleKeydown(event(String(i), true));
    editor.handleKeydown(event(String(i), false, false));
    expect(editor.active).toBe('review');
  }
  editor.handleKeydown(event('s', true));
  expect(editor.saves).toBe(1);
});

test('service endpoint branch delegates its sole panel; footer clearance and review remain', () => {
  expect(() => compile(source, { filename: 'ServiceEditor.svelte' })).not.toThrow();
  const branch = source.split("{:else if activeSection === 'endpoints'}")[1].split('{:else if')[0];
  expect(branch).not.toContain('<PanelCard');
  expect(branch).toContain('data-testid="service-nav-endpoints"');
  expect(branch).toContain('isService={true}');
  expect(source).toContain('space-y-4 pb-16');
  expect(source).toContain('service-review-summary');
  expect(source).toContain('service-save-button');
  expect(source).not.toContain('title="BUILDER"');
  const menu = source.split('<ul class="divide-y divide-carbon-600">')[1].split('</ul>')[0];
  expect(menu.match(/<li[\s>]/g)).toHaveLength(1);
  expect(menu).not.toContain('item.group');
  expect(source).toContain('aria-current={activeSection === item.id');
});

test('both locales provide the approved labels and endpoint empty states', async () => {
  for (const locale of ['zh-CN', 'en']) {
    const messages = await Bun.file(new URL(`../i18n/locales/${locale}.json`, import.meta.url)).json();
    const editor = messages.serviceEditor;
    expect(Object.keys(editor.navigation)).toEqual(['title', 'transport', 'availability']);
    const labels = create().navItems.map((item: any) => item.label.split('.').reduce((value: any, key: string) => value[key], messages));
    if (locale === 'zh-CN') {
      expect(labels).toEqual(['基本信息', '服务端点', '流量调度', '健康检查', '服务插件', '引用路由', '配置概览']);
      expect(labels.every((label: string) => [...label].length === 4)).toBe(true);
      expect(editor.builder.transport).toBe('超时与负载均衡');
      expect(editor.builder.availability).toBe('健康检查与容错');
    } else {
      expect(labels[2]).toBe('Traffic policy');
      expect(labels[3]).toBe('Health checks');
      expect(editor.builder.transport).toBe('Timeouts & Load Balancing');
      expect(editor.builder.availability).toBe('Health Checks & Failover');
    }
    for (const id of order) expect(editor.builder[id].length).toBeGreaterThan(0);
    for (const key of ['endpointSearch', 'noMatchingEndpoints', 'noEndpoints']) expect(editor[key].length).toBeGreaterThan(0);
  }
});
