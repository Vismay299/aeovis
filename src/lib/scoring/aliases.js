/**
 * Extracts brand aliases from a brand name and its website URL.
 * Sorted from longest to shortest to ensure precedence in matching.
 */
export function getBrandAliases(brand, website) {
  const aliases = new Set();
  
  if (brand && typeof brand === "string") {
    const trimmedBrand = brand.trim();
    if (trimmedBrand) {
      aliases.add(trimmedBrand);
      aliases.add(trimmedBrand.toLowerCase());

      // Remove suffixes like Corp, Inc, LLC, Software, Co, Ltd
      const cleanRegex = /\b(corp|corporation|inc|incorporated|llc|co|ltd|software|technologies|systems)\b/gi;
      const cleaned = trimmedBrand.replace(cleanRegex, "").trim();
      if (cleaned && cleaned !== trimmedBrand) {
        aliases.add(cleaned);
        aliases.add(cleaned.toLowerCase());
      }
    }
  }

  if (website && typeof website === "string") {
    try {
      let cleanedUrl = website.trim().toLowerCase();
      if (!/^https?:\/\//i.test(cleanedUrl)) {
        cleanedUrl = "http://" + cleanedUrl;
      }
      const parsed = new URL(cleanedUrl);
      const hostname = parsed.hostname.replace(/^www\./i, "");
      aliases.add(hostname);
      
      const domainName = hostname.split(".")[0];
      const brandLower = (brand || "").trim().toLowerCase();
      // Avoid ultra-short domain stems (e.g. "go") unless they appear in the brand name.
      if (
        domainName &&
        (domainName.length >= 3 ||
          (domainName.length >= 2 && brandLower.includes(domainName)))
      ) {
        aliases.add(domainName);
      }
    } catch (e) {
      // ignore
    }
  }

  return Array.from(aliases)
    .filter(alias => alias && alias.length >= 2)
    .sort((a, b) => b.length - a.length);
}
