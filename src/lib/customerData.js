function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function hostFromUrl(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Match legacy display-name rows and canonical-domain rows inside an RLS-filtered result. */
export function rowBelongsToCustomerBrand(row, brand) {
  if (!row || !brand) return false;
  const keys = new Set([
    normalized(brand.brandKey),
    normalized(brand.display_name),
    ...(Array.isArray(brand.aliases) ? brand.aliases.map(normalized) : []),
  ].filter(Boolean));
  if (keys.has(normalized(row.brand)) || keys.has(normalized(row.domain))) return true;
  const rowHost = hostFromUrl(row.url);
  return !!rowHost && rowHost === normalized(brand.website_host);
}

