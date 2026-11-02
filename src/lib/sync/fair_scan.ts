/** Rotate the scan start so a fixed hash budget eventually reaches every file. */
export function fairScanOrder<T>(items: T[], cursor: number, budget: number): { items: T[]; next: number } {
  if (!items.length || !Number.isFinite(budget) || budget <= 0) return { items, next: 0 };
  const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor % items.length : 0;
  const step = Math.min(items.length, Math.max(1, Math.floor(budget)));
  return { items: [...items.slice(start), ...items.slice(0, start)], next: (start + step) % items.length };
}
