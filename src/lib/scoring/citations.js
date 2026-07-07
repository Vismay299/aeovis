import { getBrandAliases } from "./aliases.js";

/**
 * Parses the brand domain (hostname without www.) from a website URL.
 *
 * @param {string} urlStr - The URL to parse
 * @returns {string} Domain string
 */
export function extractBrandDomain(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return "";
  try {
    let cleaned = urlStr.trim().toLowerCase();
    if (!/^https?:\/\//i.test(cleaned)) {
      cleaned = "http://" + cleaned;
    }
    const parsed = new URL(cleaned);
    return parsed.hostname.replace(/^www\./i, "");
  } catch (e) {
    return "";
  }
}

/**
 * Normalizes citation URLs by stripping query parameters, trailing slashes, and lowercasing the hostname.
 *
 * @param {string} urlStr - The URL to normalize
 * @returns {string} Normalized URL
 */
export function normalizeUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return "";
  try {
    let cleaned = urlStr.trim();
    if (!/^https?:\/\//i.test(cleaned)) {
      cleaned = "http://" + cleaned;
    }
    const parsed = new URL(cleaned);
    const hostname = parsed.hostname.toLowerCase();
    let pathname = parsed.pathname;
    
    let urlStrOut = `${parsed.protocol}//${hostname}${pathname}`;
    if (urlStrOut.endsWith("/")) {
      urlStrOut = urlStrOut.slice(0, -1);
    }
    
    return urlStrOut;
  } catch (e) {
    return urlStr.trim().toLowerCase();
  }
}

/**
 * Classifies a citation domain/URL as brand, competitor, or third_party.
 *
 * @param {string} citationUrl - The cited URL or domain
 * @param {string} brandUrl - Tracking brand URL
 * @param {Array} competitors - List of competitor brand names (or objects)
 * @returns {string} "brand" | "competitor" | "third_party"
 */
export function classifyCitation(citationUrl, brandUrl, competitors = []) {
  const citationDomain = extractBrandDomain(citationUrl);
  if (!citationDomain) return "third_party";
  
  const brandDomain = extractBrandDomain(brandUrl);
  if (brandDomain && (citationDomain === brandDomain || citationDomain.endsWith("." + brandDomain))) {
    return "brand";
  }
  
  const domainParts = citationDomain.split(".");
  
  // Check competitors
  for (const comp of competitors) {
    const compName = typeof comp === "string" ? comp : (comp.name || "");
    const compAliases = getBrandAliases(compName, "");
    
    for (const alias of compAliases) {
      const cleanAlias = alias.toLowerCase();
      if (cleanAlias.includes(".")) {
        if (citationDomain === cleanAlias || citationDomain.endsWith("." + cleanAlias)) {
          return "competitor";
        }
      } else if (cleanAlias.length >= 3) {
        if (domainParts.some(part => part.includes(cleanAlias))) {
          return "competitor";
        }
      }
    }

    // Secondary fallback: split multi-word competitor name
    const compWords = compName.split(/\s+/).filter(w => w.length >= 3 && !/^(corp|inc|llc|co|ltd|crm|software|technologies)$/i.test(w));
    for (const word of compWords) {
      if (domainParts.some(part => part.includes(word.toLowerCase()))) {
        return "competitor";
      }
    }
  }
  
  return "third_party";
}

/**
 * Aggregates top cited domains across all prompt results.
 *
 * @param {Array} results - Array of prompt results
 * @param {string} brandUrl - Brand URL
 * @param {Array} competitors - List of competitor names
 * @returns {Array} List of top 10 domains with counts and classification types
 */
export function aggregateTopDomains(results, brandUrl, competitors = []) {
  if (!results || results.length === 0) return [];
  
  const domainCounts = {};
  
  results.forEach(r => {
    const uniqueDomainsInPrompt = new Set();
    const citations = r.citations || [];
    
    citations.forEach(url => {
      const domain = extractBrandDomain(url);
      if (domain) {
        uniqueDomainsInPrompt.add(domain);
      }
    });
    
    uniqueDomainsInPrompt.forEach(domain => {
      if (!domainCounts[domain]) {
        domainCounts[domain] = 0;
      }
      domainCounts[domain]++;
    });
  });
  
  return Object.entries(domainCounts)
    .map(([domain, count]) => {
      const type = classifyCitation(domain, brandUrl, competitors);
      return { domain, count, type };
    })
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, 10);
}

/**
 * Computes citation share percentage for the tracking brand.
 *
 * @param {Array} results - Array of prompt results
 * @param {string} brandUrl - Brand website URL
 * @returns {number} Percentage (0-100)
 */
export function computeBrandCitationShare(results, brandUrl) {
  if (!results || results.length === 0) return 0.0;
  const brandDomain = extractBrandDomain(brandUrl);
  if (!brandDomain) return 0.0;
  
  let citedPromptsCount = 0;
  results.forEach(r => {
    const hasBrandCitation = (r.citations || []).some(c => {
      const domain = extractBrandDomain(c);
      return domain === brandDomain || domain.endsWith("." + brandDomain);
    });
    if (hasBrandCitation) {
      citedPromptsCount++;
    }
  });
  return Math.round((citedPromptsCount / results.length) * 1000) / 10;
}

/**
 * Computes citation share percentage for a competitor.
 *
 * @param {Array} results - Array of prompt results
 * @param {string} competitor - Competitor name
 * @returns {number} Percentage (0-100)
 */
export function computeCompetitorCitationShare(results, competitor) {
  if (!results || results.length === 0) return 0.0;
  let citedPromptsCount = 0;
  
  results.forEach(r => {
    const hasCompCitation = (r.citations || []).some(c => {
      return classifyCitation(c, "", [competitor]) === "competitor";
    });
    if (hasCompCitation) {
      citedPromptsCount++;
    }
  });
  return Math.round((citedPromptsCount / results.length) * 1000) / 10;
}
