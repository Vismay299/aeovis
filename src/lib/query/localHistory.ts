// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/hooks/useLocalHistoryStore.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const HISTORY_LIMIT = 20;

export function historyStorageKey(feature: string, brandKey: string): string {
  return `perceev:recent:${feature}:${brandKey}`;
}

export function loadHistory<T>(
  storage: Storage | null,
  key: string,
  parse: (raw: string) => T[] | null,
  max = HISTORY_LIMIT
): T[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = parse(raw);
    return parsed ? parsed.slice(0, max) : [];
  } catch {
    return [];
  }
}

export function addHistoryItem<T, A>(
  items: T[],
  input: A,
  o: {
    isSame(a: T, b: A): boolean;
    create(a: A): T;
    max?: number;
  }
): T[] {
  const max = o.max ?? HISTORY_LIMIT;
  const filtered = items.filter((existing) => !o.isSame(existing, input));
  return [o.create(input), ...filtered].slice(0, max);
}

export function removeHistoryItem<T>(
  items: T[],
  itemKey: number,
  getKey: (t: T) => number
): T[] {
  return items.filter((item) => getKey(item) !== itemKey);
}

export function saveHistory(
  storage: Storage | null,
  key: string,
  items: unknown[]
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(items));
  } catch {
    // storage full or unavailable - silently ignore
  }
}
