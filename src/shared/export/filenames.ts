/**
 * Format an export filename from a list of descriptive parts.
 * Lower-cases, converts non-alphanumeric characters to hyphens,
 * collapses multiple hyphens, prefixes with "perceev-", and caps at 120 characters.
 */
export function exportFilename(parts: string[]): string {
  const normalizedParts = parts
    .map((part) =>
      part
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean);

  const joined = normalizedParts.join("-");
  const base = joined ? `perceev-${joined}` : "perceev";

  if (base.length <= 120) {
    return base;
  }

  return base.slice(0, 120).replace(/-+$/, "");
}
