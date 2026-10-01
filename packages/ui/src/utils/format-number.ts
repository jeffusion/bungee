/** Compact decimal units shared by dashboard metrics and plugin views. Unknown values stay unknown. */
export function formatCompactNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const units = ['', 'K', 'M', 'B', 'T'] as const;
  let unit = 0;
  let amount = Math.abs(value);
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit++;
  }
  // Rounding at a unit boundary should produce 1M, rather than 1000K.
  if (Number(amount.toFixed(2)) >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit++;
  }
  const rounded = Number(amount.toFixed(2));
  return `${value < 0 && rounded !== 0 ? '-' : ''}${rounded}${units[unit]}`;
}
