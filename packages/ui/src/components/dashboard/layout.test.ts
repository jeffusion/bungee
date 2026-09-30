import { describe, expect, test } from 'bun:test';
import { BUILTIN_CARDS, cloneLayout, defaultLayout, layoutSignature, parseLayout, type CardDefinition, type DashboardLayout } from './layout';

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
  test('defaults preserve all original metrics, health cards, and monitoring charts', () => {
    const layout = parseLayout(defaultLayout());
    expect(layout.cards.map(card => card.id).sort()).toEqual(BUILTIN_CARDS.map(card => card.id).sort());
    expect(layout.cards.filter(card => card.id.startsWith('kpi.')).every(card => card.y === 0)).toBe(true);
  });
  test('unavailable plugin slots survive with their identity and title', () => {
    const plugin: CardDefinition = { id: 'plugin:native:quota:overview', title: 'Quota', description: '', group: 'plugin', tag: 'QUOTA', w: 6, h: 2 };
    const layout = defaultLayout([plugin]);
    layout.cards.at(-1)!.title = plugin.title;
    expect(parseLayout(layout).cards.at(-1)).toEqual(layout.cards.at(-1));
    expect(defaultLayout([{ ...plugin, enabled: false }]).cards).toHaveLength(14);
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
    expect(migrated.version).toBe(3);
    expect(migrated.mobile).toEqual(legacy.mobile);
    expect(migrated.cards[0].x + migrated.cards[0].w).toBe(migrated.cards[1].x);
    expect(migrated.cards[2].w).toBe(15);
    expect(parseLayout(migrated)).toEqual(migrated);
    expect(legacy.cards[2].w).toBe(12);
  });
  test('accepts an intentionally empty dashboard', () => {
    expect(parseLayout({ version: 3, cards: [], mobile: [] }).cards).toHaveLength(0);
  });
  test('rejects duplicates, invalid bounds, overlaps, and incomplete mobile layouts', () => {
    const mutations = [
      (layout: any) => layout.cards.push(layout.cards[0]),
      (layout: any) => layout.cards[0].x = -1,
      (layout: any) => layout.cards[0].w = 16,
      (layout: any) => layout.cards[0].h = 1,
      (layout: any) => layout.cards[0].y = 0.5,
      (layout: any) => layout.cards[1].x = 0,
      (layout: any) => layout.mobile.pop(),
      (layout: any) => layout.mobile[0].height = 'huge',
      (layout: any) => layout.mobile[1].id = layout.mobile[0].id,
      (layout: any) => layout.cards[0].id = 'unrecognized',
    ];
    for (const mutation of mutations) { const layout = defaultLayout(); mutation(layout); expect(() => parseLayout(layout)).toThrow(); }
    for (const value of [null, {}, { version: 1 }, [], 'invalid']) expect(() => parseLayout(value)).toThrow();
  });
});
