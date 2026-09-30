export type CardGroup = 'kpi' | 'trend' | 'upstream' | 'health' | 'plugin';
export type MobileHeight = 'compact' | 'standard' | 'tall';
export interface CardDefinition {
  id: string;
  title: string;
  description: string;
  group: CardGroup;
  tag: string;
  stripe?: 'orange' | 'emerald' | 'red' | 'amber' | 'zinc';
  w: number;
  h: number;
  enabled?: boolean;
  pluginName?: string;
}
export interface LayoutCard { id: string; x: number; y: number; w: number; h: number; title?: string; pluginName?: string }
export interface DashboardLayout { version: 3; cards: LayoutCard[]; mobile: { id: string; height: MobileHeight }[] }
export const GRID_COLUMNS = 15;
export const LEGACY_LAYOUT_KEY = 'bungee.dashboard.layout.v2';
export const LAYOUT_KEY = 'bungee.dashboard.layout.v3';
export const GROUPS: CardGroup[] = ['kpi', 'trend', 'upstream', 'health', 'plugin'];
const definitions: [string, string, CardGroup, string, CardDefinition['stripe']?][] = [
  ['kpi.requests', 'dashboard.totalRequests', 'kpi', 'KPI-01'],
  ['kpi.success', 'dashboard.successRate', 'kpi', 'KPI-02'],
  ['kpi.latency', 'dashboard.avgResponseTime', 'kpi', 'KPI-03'],
  ['kpi.cluster', 'dashboard.clusterOverview', 'kpi', 'KPI-04'],
  ['kpi.rpm', 'dashboard.requestsPerMinute', 'kpi', 'KPI-05'],
  ['chart.requests', 'monitoring.charts.requestsTrend', 'trend', 'CH-01'],
  ['chart.latency', 'monitoring.charts.responseTimeTrend', 'trend', 'CH-02'],
  ['chart.success', 'monitoring.charts.successRateTrend', 'trend', 'CH-03', 'emerald'],
  ['chart.errors', 'monitoring.charts.errorsTrend', 'trend', 'CH-04', 'red'],
  ['chart.upstreams', 'dashboard.upstreamDistribution', 'upstream', 'SECTOR-A'],
  ['chart.failures', 'dashboard.upstreamFailures', 'upstream', 'SECTOR-B', 'red'],
  ['chart.status', 'dashboard.upstreamStatusCodes', 'upstream', 'MATRIX'],
  ['health.services', 'dashboard.serviceOverview', 'health', 'HEALTH'],
  ['health.routes', 'dashboard.routeOverview', 'health', 'ROUTES'],
];
export const BUILTIN_CARDS: CardDefinition[] = definitions.map(([id, title, group, tag, stripe]) => ({
  id, title, group, tag, stripe, description: `dashboardLayout.descriptions.${id.replace('.', '_')}`,
  w: group === 'kpi' ? 3 : 8, h: group === 'kpi' ? 2 : 4,
}));
export interface KpiMetric {
  value: string | number | null;
  unit: string;
  tone?: 'auto' | 'ok' | 'warn' | 'danger' | 'accent';
  trend?: number | null;
  trendLabel?: string;
  trendCaption?: string;
  trendTitle?: string;
  trendDirection?: 'up' | 'down';
  stripe?: CardDefinition['stripe'];
}
// Keep the original five KPIs and the complete cluster / monitoring content.
export const DEFAULT_IDS = ['kpi.requests', 'kpi.rpm', 'kpi.success', 'kpi.latency', 'kpi.cluster',
  'health.services', 'health.routes', 'chart.requests', 'chart.latency', 'chart.success', 'chart.errors',
  'chart.upstreams', 'chart.failures', 'chart.status'];
export function defaultLayout(plugins: CardDefinition[] = []): DashboardLayout {
  const geometry = [
    [0,0,3,2], [3,0,3,2], [6,0,3,2], [9,0,3,2], [12,0,3,2],
    [0,2,5,8], [0,10,5,8], [5,2,5,4], [10,2,5,4], [5,6,5,4], [10,6,5,4],
    [5,10,5,4], [5,14,5,4], [10,10,5,8],
  ];
  const cards = DEFAULT_IDS.map((id, i) => { const [x,y,w,h] = geometry[i]; return { id, x, y, w, h }; });
  let y = 18;
  for (const plugin of plugins.filter(p => p.enabled !== false)) {
    cards.push({ id: plugin.id, x: 0, y, w: plugin.w, h: plugin.h });
    y += plugin.h;
  }
  return { version: 3, cards, mobile: cards.map(c => ({ id: c.id, height: 'standard' })) };
}
export function minWidth(definition: CardDefinition): number { return definition.group === 'kpi' || definition.group === 'plugin' ? 3 : 4; }
export function minHeight(definition: CardDefinition): number { return definition.group === 'kpi' || definition.group === 'plugin' ? 2 : 3; }
export function cloneLayout(layout: DashboardLayout): DashboardLayout { return JSON.parse(JSON.stringify(layout)); }
export function layoutSignature(layout: DashboardLayout): string {
  return JSON.stringify({ cards: [...layout.cards].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, x, y, w, h }) => ({ id, x, y, w, h })), mobile: layout.mobile });
}
/** Reject malformed persisted geometry; retain unavailable plugin slots for reactivation. */
export function parseLayout(value: unknown): DashboardLayout {
  if (!value || typeof value !== 'object') throw new Error('Invalid layout');
  const data = value as Omit<DashboardLayout, 'version'> & { version: number };
  const columns = data.version === 2 ? 12 : GRID_COLUMNS;
  if ((data.version !== 2 && data.version !== 3) || !Array.isArray(data.cards) || !Array.isArray(data.mobile) || data.cards.length > 200) throw new Error('Invalid schema');
  const ids = new Set<string>();
  for (const card of data.cards) {
    if (!card || typeof card.id !== 'string' || ids.has(card.id)) throw new Error('Invalid card');
    const definition = BUILTIN_CARDS.find(d => d.id === card.id);
    if (!definition && !card.id.startsWith('plugin:')) throw new Error('Unknown card');
    if (![card.x, card.y, card.w, card.h].every(Number.isInteger) || card.x < 0 || card.y < 0 || card.y > 2000 ||
      card.w < (definition ? minWidth(definition) : 3) || card.h < (definition ? minHeight(definition) : 2) || card.x + card.w > columns || card.h > 20) throw new Error('Invalid geometry');
    if (card.title !== undefined && typeof card.title !== 'string' || card.pluginName !== undefined && typeof card.pluginName !== 'string') throw new Error('Invalid metadata');
    ids.add(card.id);
  }
  for (let i = 0; i < data.cards.length; i++) for (const other of data.cards.slice(i + 1)) {
    const card = data.cards[i];
    if (card.x < other.x + other.w && card.x + card.w > other.x && card.y < other.y + other.h && card.y + card.h > other.y) throw new Error('Overlapping cards');
  }
  const mobileIds = new Set<string>();
  for (const entry of data.mobile) {
    if (!entry || !ids.has(entry.id) || mobileIds.has(entry.id) || !['compact', 'standard', 'tall'].includes(entry.height)) throw new Error('Invalid mobile layout');
    mobileIds.add(entry.id);
  }
  if (mobileIds.size !== ids.size) throw new Error('Incomplete mobile layout');
  if (data.version === 2) {
    // Scale shared edges together to preserve adjacency and avoid overlap.
    return { version: 3, cards: data.cards.map(card => {
      const x = Math.floor(card.x * GRID_COLUMNS / 12);
      return { ...card, x, w: Math.floor((card.x + card.w) * GRID_COLUMNS / 12) - x };
    }), mobile: data.mobile.map(entry => ({ ...entry })) };
  }
  return cloneLayout(data as DashboardLayout);
}
