import { describe, expect, test } from 'bun:test';
import { BUILTIN_CARDS, GRID_COLUMNS, cloneLayout, defaultLayout, templateLayout, layoutSignature, parseLayout, type CardDefinition, type DashboardLayout } from '../../../../src/components/dashboard/layout';

describe('dashboard layout persistence', () => {
  test('round trips desktop geometry and independent mobile order and height', () => {
    const layout = defaultLayout();
    const geometry = JSON.stringify(layout.cards);
    layout.mobile.reverse(); layout.mobile[0].height = 'tall';
    const restored = parseLayout(JSON.parse(JSON.stringify(layout)));
    expect(JSON.stringify(restored.cards)).toBe(geometry);
    expect(restored.mobile).toEqual(layout.mobile);
    expect(BUILTIN_CARDS).toHaveLength(14);
  });
  test('API template curates common gateway cards without filling the whole library', () => {
    const layout = parseLayout(templateLayout('api'));
    expect(layout).toEqual(templateLayout('api'));
    expect(layout.cards).toHaveLength(10);
    expect(layout.cards.map(card => card.id)).toContain('health.services');
    expect(layout.cards.map(card => card.id)).toContain('chart.failures');
    expect(layout.cards.map(card => card.id)).not.toContain('chart.status');
    expect(layout.cards.filter(card => card.id.startsWith('kpi.')).every(card => card.y === 0)).toBe(true);
    expect(layout.cards.filter(card => card.id.startsWith('kpi.')).map(card => card.w)).toEqual([6, 6, 6, 6, 6]);
  });
  test('initial layout uses the LLM template', () => {
    expect(defaultLayout()).toEqual(templateLayout('llm'));
    expect(defaultLayout().cards.filter(card => card.id.startsWith('kpi.')).map(card => card.id))
      .toEqual(['kpi.rpm', 'kpi.success', 'kpi.latency']);
  });
  test('unavailable plugin slots survive with their identity and title', () => {
    const plugin: CardDefinition = { id: 'plugin:native:quota:overview', title: 'Quota', description: '', group: 'plugin', tag: 'QUOTA', w: 6, h: 2 };
    const layout = defaultLayout();
    layout.cards.push({ id: plugin.id, title: plugin.title, x: 0, y: 32, w: 6, h: 4 });
    layout.mobile.push({ id: plugin.id, height: 'tall' });
    expect(parseLayout(layout).cards.at(-1)).toEqual(layout.cards.at(-1));
    expect(parseLayout(layout).mobile.at(-1)?.height).toBe('tall');
  });
  test('LLM template includes only available Token cards, independent of catalog order', () => {
    const token = (name: string, h: number): CardDefinition => ({ id: `plugin:native:token-stats:token-stats-${name}`, title: name, description: '', group: 'plugin', tag: 'TOKEN', pluginName: 'token-stats', w: 15, h });
    const overview = token('overview', 2), time = token('time', 4);
    const unrelated = { ...overview, id: 'plugin:iframe:unrelated:card' };
    const plugins = [unrelated, time, overview];
    const api = parseLayout(templateLayout('api', plugins));
    expect(api.cards.some(card => card.id.startsWith('plugin:'))).toBe(false);
    const llm = parseLayout(templateLayout('llm', plugins));
    expect(llm.cards.filter(card => card.id.startsWith('plugin:')).map(card => card.id)).toEqual([overview.id, time.id]);
    expect(llm.mobile.map(card => card.id)).toEqual(llm.cards.map(card => card.id));
    expect(defaultLayout(plugins)).toEqual(llm);
    expect(llm.cards).toHaveLength(13);
    expect(llm.cards.filter(card => card.id.startsWith('plugin:')).map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual([
      { x: 18, y: 0, w: 12, h: 4 }, { x: 10, y: 4, w: 20, h: 8 },
    ]);
    expect(llm.cards.find(card => card.id === 'health.services')).toMatchObject({ x: 0, y: 4, w: 10, h: 16 });
    expect(llm.cards.find(card => card.id === 'health.routes')).toMatchObject({ x: 0, y: 20, w: 10, h: 16 });
    expect(llm.cards.find(card => card.id === 'chart.status')).toMatchObject({ x: 20, y: 28, w: 10, h: 8 });
    expect(parseLayout(templateLayout('llm', [unrelated, { ...overview, enabled: false }])).cards).toHaveLength(11);
    const partial = parseLayout(templateLayout('llm', [time]));
    expect(partial.cards.find(card => card.id === time.id)).toMatchObject({ x: 10, y: 4, w: 20, h: 8 });
    expect(partial.cards[0].w).toBe(10);
    const noTime = parseLayout(templateLayout('llm', [overview]));
    expect(noTime.cards.find(card => card.id === 'health.services')?.h).toBe(8);
    expect(noTime.cards.find(card => card.id === 'chart.requests')?.y).toBe(4);
    const draft = cloneLayout(llm);
    draft.cards = draft.cards.filter(card => card.id !== overview.id);
    draft.mobile = draft.mobile.filter(card => card.id !== overview.id);
    expect(parseLayout(draft).cards.map(card => card.id)).not.toContain(overview.id);
    expect(llm.cards.map(card => card.id)).toContain(overview.id);
  });
  test('draft cloning isolates saved layouts and signatures ignore desktop array ordering', () => {
    const saved = defaultLayout(); const draft = cloneLayout(saved);
    draft.cards.reverse(); expect(layoutSignature(saved)).toBe(layoutSignature(draft));
    draft.cards[0].h++;
    expect(layoutSignature(saved)).not.toBe(layoutSignature(draft));
    expect(saved.cards.at(-1)!.h).toBe(8);
  });
  test('migrates saved twelve-column layouts without losing cards or mobile preferences', () => {
    const legacy: Omit<DashboardLayout, 'version'> & { version: 2 } = { version: 2, cards: [
      { id: 'kpi.requests', x: 0, y: 0, w: 3, h: 2 },
      { id: 'kpi.success', x: 3, y: 0, w: 3, h: 2 },
      { id: 'chart.requests', x: 0, y: 2, w: 12, h: 4 },
    ], mobile: [{ id: 'kpi.success', height: 'tall' }, { id: 'kpi.requests', height: 'compact' }, { id: 'chart.requests', height: 'standard' }] };
    const migrated = parseLayout(legacy);
    expect(migrated.version).toBe(5);
    expect(migrated.mobile).toEqual(legacy.mobile);
    expect(migrated.cards[0].x + migrated.cards[0].w).toBe(migrated.cards[1].x);
    expect(migrated.cards[2].w).toBe(GRID_COLUMNS);
    expect(parseLayout(migrated)).toEqual(migrated);
    expect(legacy.cards[2].w).toBe(12);
  });
  test('doubles fifteen-column geometry while preserving plugin slots and mobile preferences', () => {
    const previous = { version: 3, cards: [
      { id: 'kpi.requests', x: 0, y: 0, w: 3, h: 2 },
      { id: 'chart.requests', x: 3, y: 0, w: 4, h: 4 },
      { id: 'plugin:native:quota:overview', x: 7, y: 0, w: 8, h: 2, title: 'Quota', pluginName: 'quota' },
    ], mobile: [{ id: 'plugin:native:quota:overview', height: 'tall' }, { id: 'chart.requests', height: 'standard' }, { id: 'kpi.requests', height: 'compact' }] };
    const migrated = parseLayout(previous);
    expect(migrated.cards).toEqual(previous.cards.map(card => ({ ...card, x: card.x * 2, w: card.w * 2, y: card.y * 2, h: card.h * 2 })));
    expect(migrated.mobile).toEqual(previous.mobile);
    expect(parseLayout(migrated)).toEqual(migrated);
    expect(previous.cards[2].w).toBe(8);
  });
  test('accepts two exactly equal half-width charts without overlap', () => {
    const cards = ['chart.requests', 'chart.latency'].map((id, i) => ({ id, x: i * 15, y: 0, w: 15, h: 8 }));
    expect(parseLayout({ version: 5, cards, mobile: cards.map(card => ({ id: card.id, height: 'standard' })) }).cards).toEqual(cards);
  });
  test('accepts an intentionally empty dashboard', () => {
    expect(parseLayout({ version: 4, cards: [], mobile: [] }).cards).toHaveLength(0);
  });
  test('migrates coarse rows once without changing physical geometry or mobile preferences', () => {
    const old = { version: 4, cards: [
      { id: 'kpi.rpm', x: 6, y: 1, w: 6, h: 2 },
      { id: 'plugin:native:quota:overview', x: 0, y: 7, w: 15, h: 5, title: 'Quota', pluginName: 'quota' },
    ], mobile: [{ id: 'plugin:native:quota:overview', height: 'tall' }, { id: 'kpi.rpm', height: 'compact' }] };
    const before = JSON.stringify(old);
    const migrated = parseLayout(old);
    expect(migrated.version).toBe(5);
    expect(migrated.cards).toEqual(old.cards.map(card => ({ ...card, y: card.y * 2, h: card.h * 2 })));
    expect(migrated.mobile).toEqual(old.mobile);
    expect(parseLayout(migrated)).toEqual(migrated);
    expect(JSON.stringify(old)).toBe(before);
    migrated.cards[0].h = 5;
    migrated.cards[0].y = 3;
    expect(parseLayout(migrated).cards[0]).toMatchObject({ y: 3, h: 5 });
  });
  test('rejects duplicates, invalid bounds, overlaps, and incomplete mobile layouts', () => {
    const mutations = [
      (layout: any) => layout.cards.push(layout.cards[0]),
      (layout: any) => layout.cards[0].x = -1,
      (layout: any) => layout.cards[0].w = GRID_COLUMNS + 1,
      (layout: any) => layout.cards[0].w = 5,
      (layout: any) => layout.cards[0].h = 1,
      (layout: any) => layout.cards[0].y = 0.5,
      (layout: any) => layout.cards[1].x = 0,
      (layout: any) => layout.mobile.pop(),
      (layout: any) => layout.mobile[0].height = 'huge',
      (layout: any) => layout.mobile[1].id = layout.mobile[0].id,
      (layout: any) => layout.cards[0].id = 'unrecognized',
    ];
    for (const mutation of mutations) { const layout = templateLayout('api'); mutation(layout); expect(() => parseLayout(layout)).toThrow(); }
    for (const value of [null, {}, { version: 1 }, [], 'invalid']) expect(() => parseLayout(value)).toThrow();
  });
});
