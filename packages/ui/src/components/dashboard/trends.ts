/** Compare the latest two time buckets, never invent a previous-range aggregate. */
export function bucketTrend(values: number[], percentagePoints = false): number | null {
  if (values.length < 2) return null;
  const previous = values.at(-2)!;
  const current = values.at(-1)!;
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
  if (percentagePoints) return current - previous;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous) * 100;
}
