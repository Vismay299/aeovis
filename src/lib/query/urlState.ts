// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/saved.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export function parseSearchParams<S extends Record<string, unknown>>(
  params: URLSearchParams,
  schema: { safeParse(v: unknown): { success: boolean; data?: S } },
  defaults: S,
  arrays?: readonly (keyof S)[]
): S {
  const result = { ...defaults };
  const arraySet = new Set((arrays ?? []).map(String));

  for (const key of Object.keys(defaults)) {
    if (!params.has(key)) {
      continue;
    }

    let rawValue: unknown;
    if (arraySet.has(key)) {
      rawValue = params.getAll(key);
    } else {
      rawValue = params.get(key);
    }

    // Coerce numeric strings for keys whose default is a number
    if (typeof defaults[key] === "number" && typeof rawValue === "string") {
      const num = Number(rawValue);
      if (Number.isFinite(num)) {
        rawValue = num;
      }
    }

    // Safe parse each key separately against the schema so an invalid param
    // falls back to its default without resetting other valid params.
    const testCandidate = { ...defaults, [key]: rawValue };
    const parsed = schema.safeParse(testCandidate);
    if (parsed.success && parsed.data && Object.prototype.hasOwnProperty.call(parsed.data, key)) {
      result[key as keyof S] = parsed.data[key as keyof S];
    } else {
      result[key as keyof S] = defaults[key as keyof S];
    }
  }

  return result;
}

export function buildSearch<S extends Record<string, unknown>>(
  current: URLSearchParams,
  patch: Partial<S>,
  defaults: S
): string {
  const map = new Map<string, string[]>();

  // Copy existing params into map
  for (const [k, v] of current.entries()) {
    if (!map.has(k)) {
      map.set(k, []);
    }
    map.get(k)!.push(v);
  }

  // Check all defaults in existing map: if already matching default, mark for potential drop
  for (const key of Object.keys(defaults)) {
    if (map.has(key) && !Object.prototype.hasOwnProperty.call(patch, key)) {
      const currentVals = map.get(key)!;
      const def = defaults[key];
      if (
        (currentVals.length === 1 && currentVals[0] === String(def)) ||
        (Array.isArray(def) &&
          currentVals.length === def.length &&
          currentVals.every((v, i) => v === String(def[i])))
      ) {
        map.delete(key);
      }
    }
  }

  // Apply patch
  for (const [key, val] of Object.entries(patch)) {
    const def = defaults[key as keyof S];
    const isDefault =
      val === def ||
      (Array.isArray(val) &&
        Array.isArray(def) &&
        val.length === def.length &&
        val.every((v, i) => v === def[i]));

    const shouldDrop =
      val === undefined ||
      val === null ||
      val === "" ||
      (Array.isArray(val) && val.length === 0) ||
      isDefault;

    if (shouldDrop) {
      map.delete(key);
    } else if (Array.isArray(val)) {
      map.set(key, val.map(String));
    } else {
      map.set(key, [String(val)]);
    }
  }

  // Sort keys for stable URLs
  const sortedKeys = Array.from(map.keys()).sort();
  const searchParams = new URLSearchParams();

  for (const k of sortedKeys) {
    for (const v of map.get(k)!) {
      searchParams.append(k, v);
    }
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}
