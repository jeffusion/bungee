/** Pack consecutive accounts by their measured height. Keep every account once. */
export function paginateQuotaAccounts(heights: readonly number[], availableHeight: number, gap: number, controlsHeight = 24): number[][] {
  if (!heights.length) return [];
  if (!Number.isFinite(availableHeight) || availableHeight <= 0 || heights.some(height => !Number.isFinite(height) || height <= 0)) {
    return heights.map((_, index) => [index]);
  }
  const spacing = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const total = heights.reduce((sum, height) => sum + height, 0) + spacing * (heights.length - 1);
  if (total <= availableHeight) return [heights.map((_, index) => index)];
  const budget = Math.max(0, availableHeight - Math.max(0, controlsHeight));
  const pages: number[][] = [];
  let page: number[] = [], used = 0;
  for (const [index, height] of heights.entries()) {
    const required = height + (page.length ? spacing : 0);
    if (page.length && used + required > budget) {
      pages.push(page); page = []; used = 0;
    }
    used += height + (page.length ? spacing : 0);
    page.push(index);
  }
  pages.push(page);
  return pages;
}
