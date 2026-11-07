// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/types.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { PageFetchClass } from "../../shared/audit-fetch-class.ts";

export interface AuditConfig {
  maxPages: number;
  lighthouse: boolean;
  renderJavaScript: boolean;
  sitePlatform?: "shopify";
  crawlerCredentialId?: string;
}

export interface PageLink {
  targetUrl: string;
  anchor: string | null;
  isInternal: boolean;
  isNofollow: boolean;
}

export interface HreflangEntry {
  lang: string;
  href: string | null;
}

export interface StructuredDataInspection {
  blocks: Array<{ parseState: "valid" | "invalid"; types: string[] }>;
  missingType: number;
  missingRequired: Array<{ type: string; missing: string[] }>;
  claimsNotVisible: Array<{ path: string; value: string }>;
}

export interface PageAnalysis {
  url: string;
  statusCode: number;
  redirectUrl: string | null;
  responseTimeMs: number;

  title: string;
  metaDescription: string;
  canonical: string | null;
  robotsMeta: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;

  h1s: string[];
  headingOrder: number[];

  wordCount: number;
  bodyText: string;
  javascriptShell?: boolean;

  images: Array<{ src: string | null; alt: string | null }>;
  links: PageLink[];

  hasStructuredData: boolean;
  hreflangTags: string[];
  hreflang: HreflangEntry[];
  jsonLdBlocks: string[];
  dataNosnippet: boolean;
}

export interface LighthouseResult {
  url: string;
  pageId: string;
  strategy: "mobile" | "desktop";
  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  errorMessage?: string | null;
  r2Key?: string | null;
  payloadSizeBytes?: number | null;
}

export interface CrawledPageResult {
  id: string;
  url: string;
  statusCode: number;
  fetchClass: PageFetchClass;
  redirectUrl: string | null;
  blockedReason?: string | null;
  title: string;
  metaDescription: string;
  canonicalUrl: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  headerCanonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  h1Count: number;
  h2Count: number;
  h3Count: number;
  h4Count: number;
  h5Count: number;
  h6Count: number;
  headingOrder: number[];
  wordCount: number;
  contentHash: string | null;
  isHtml: boolean;
  javascriptShell?: boolean;
  htmlBytes: number;
  rateLimited: boolean;
  imagesTotal: number;
  imagesMissingAlt: number;
  images: Array<{ src: string | null; alt: string | null }>;
  links: PageLink[];
  hasStructuredData: boolean;
  hreflangTags: string[];
  hreflang: HreflangEntry[];
  structuredData: StructuredDataInspection;
  structuredDataTypes: string[];
  dataNosnippet: boolean;
  rendered: boolean;
  isIndexable: boolean;
  responseTimeMs: number;
  crawlDepth: number | null;
  inSitemap: boolean;
}

export interface ClaimedUrl {
  url: string;
  depth: number | null;
  inSitemap: boolean;
  retries: number;
}

export interface FrontierStats {
  pending: number;
  leased: number;
  crawled: number;
  total: number;
}
