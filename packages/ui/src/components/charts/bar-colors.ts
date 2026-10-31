/**
 * Fixed categorical palette for chart series. Nine value-separated channels
 * for carbon surfaces: the near sky/cyan and emerald/teal duplicates are
 * removed, and violet/rose plus sky/deep-blue are split by lightness. Orange
 * leads; coral is the soft red variant, while alarm red stays out. Order is
 * the contract; an explicit semantic color still wins.
 */
export const BAR_PALETTE = [
  '#f97316', // orange — primary series
  '#38bdf8', // sky
  '#8b5cf6', // violet, deeper than rose
  '#f472b6', // rose, lighter than violet
  '#34d399', // emerald
  '#f6c445', // gold
  '#2563eb', // deep blue, darker than sky
  '#a3e635', // lime
  '#ff8f7a', // coral — soft red variant, not alarm red
] as const;

export function barSeriesColor(index: number, explicit?: string): string {
  return explicit ?? BAR_PALETTE[index % BAR_PALETTE.length];
}
