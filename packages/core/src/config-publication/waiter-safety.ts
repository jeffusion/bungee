export function boundedError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.slice(0, 512)
    : fallback;
}

export function bestEffort(action: () => void): void {
  try { action(); }
  catch { return; }
}
