import { candidateSiteUrls } from "../../shared/engines/gsc.js";

export function resolveCustomerGscProperty(input, accessibleSites) {
  const value = String(input || "").trim();
  const tried = value.startsWith("sc-domain:") ? [value] : candidateSiteUrls(value);
  const readable = new Set((accessibleSites || [])
    .filter((site) => site.permissionLevel && site.permissionLevel !== "siteUnverifiedUser")
    .map((site) => site.siteUrl));
  if (readable.has(value)) return { siteUrl: value, tried: [value] };
  return { siteUrl: tried.find((candidate) => readable.has(candidate)) || null, tried, accessible: [...readable] };
}
