// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/keywords/hooks/usePreferredKeywordLocation.ts
//   src/client/features/keywords/page/KeywordResearchPagination.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export function prefStorageKey(key: string, brandKey?: string): string {
  return brandKey ? `perceev:pref:${key}:${brandKey}` : `perceev:pref:${key}`;
}

export function readPref<T>(
  storage: Storage | null,
  fullKey: string,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  fallback: T
): T {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(fullKey);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    return result.success && result.data !== undefined ? result.data : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(
  storage: Storage | null,
  fullKey: string,
  value: unknown
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(fullKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
