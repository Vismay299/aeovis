// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/filterSearchParams.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * Filter panels hold text. The URL holds numeric fields as numbers, so it
 * reads `?minVol=100` and not `?minVol="100"`. `include` and `exclude` stay
 * text.
 */
export function isTextField(
  key: string,
  textFields: readonly string[] = ["include", "exclude"]
): boolean {
  return textFields.includes(key);
}

export function filterValuesFromSearch<TValues extends Record<string, string>>(
  search: Partial<Record<keyof TValues, string | number>>,
  empty: TValues
): TValues {
  const values = { ...empty };
  for (const key in empty) {
    const value = search[key];
    if (value !== undefined) Object.assign(values, { [key]: String(value) });
  }
  return values;
}

export function filterValuesToSearch<TSearch extends Record<string, unknown> = Record<string, unknown>>(
  values: Record<string, string>,
  textFields: readonly string[] = ["include", "exclude"]
): Partial<TSearch> {
  const update: Partial<TSearch> = {};
  for (const [key, raw] of Object.entries(values)) {
    const value = raw.trim();
    const parsed = Number(value);
    Object.assign(update, {
      [key]:
        value === ""
          ? undefined
          : isTextField(key, textFields)
            ? value
            : Number.isFinite(parsed)
              ? parsed
              : undefined,
    });
  }
  return update;
}

/** Filter values as they come back from the URL ("10." becomes "10"). */
export function normalizeFilterValues<TValues extends Record<string, string>>(
  values: TValues,
  empty: TValues,
  textFields: readonly string[] = ["include", "exclude"]
): TValues {
  return filterValuesFromSearch(filterValuesToSearch(values, textFields), empty);
}
