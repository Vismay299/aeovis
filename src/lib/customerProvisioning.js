import crypto from "crypto";

export function normalizeCustomerBrand({ brandKey, brandName, website }) {
  const name = String(brandName || "").trim();
  if (!name || name.length > 120) return { error: "brand_name is required and must be 120 characters or fewer." };
  let parsed;
  try { parsed = new URL(String(website || "")); } catch { return { error: "website must be a valid HTTPS website URL." }; }
  if (parsed.protocol !== "https:" || !parsed.hostname.includes(".")) {
    return { error: "website must be a valid HTTPS domain." };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  // New workspaces get opaque UUID keys. Existing domain-based keys are preserved.
  const key = brandKey ? String(brandKey).trim().toLowerCase() : crypto.randomUUID();
  return {
    value: {
      brand_key: key,
      display_name: name,
      website: parsed.origin,
      website_host: host,
      aliases: [...new Set([name.toLowerCase(), host])],
      is_active: true,
      updated_at: new Date().toISOString(),
    },
  };
}

/** Prevent legacy brand aliases from overlapping another tenant's RLS scope. */
export async function findCustomerBrandAliasConflict(admin, brand) {
  const aliases = [...new Set([brand.brand_key, ...(brand.aliases || [])]
    .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  const { data, error } = await admin.from("customer_brand_aliases")
    .select("alias, brand_key")
    .in("alias", aliases);
  if (error) return { error, conflict: null };
  const row = (data || []).find((candidate) => candidate.brand_key !== brand.brand_key);
  if (row) return { error: null, conflict: row };
  return { error: null, conflict: null };
}

/** Register legacy labels atomically under the database's unique alias key. */
export async function registerCustomerBrandAliases(admin, brand) {
  const collision = await findCustomerBrandAliasConflict(admin, brand);
  if (collision.error || collision.conflict) return collision;

  const aliases = [...new Set([brand.brand_key, ...(brand.aliases || [])]
    .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  const { data: existing, error: readError } = await admin.from("customer_brand_aliases")
    .select("alias")
    .eq("brand_key", brand.brand_key);
  if (readError) return { error: readError, conflict: null };
  const existingAliases = new Set((existing || []).map((row) => row.alias));
  const missing = aliases.filter((alias) => !existingAliases.has(alias));

  if (missing.length) {
    const { error } = await admin.from("customer_brand_aliases").insert(
      missing.map((alias) => ({ alias, brand_key: brand.brand_key }))
    );
    if (error) {
      const afterRace = await findCustomerBrandAliasConflict(admin, brand);
      if (afterRace.conflict || afterRace.error) return afterRace;
      const racedRead = await admin.from("customer_brand_aliases").select("alias").eq("brand_key", brand.brand_key);
      if (racedRead.error) return { error: racedRead.error, conflict: null };
      if (aliases.every((alias) => (racedRead.data || []).some((row) => row.alias === alias))) {
        return { error: null, conflict: null, aliases: (racedRead.data || []).map((row) => row.alias) };
      }
      return { error, conflict: null };
    }
  }

  return { error: null, conflict: null, aliases: [...existingAliases, ...missing] };
}
