// Site audit fixture types for Perceev test harness.

import type { AuditIssueType } from "../../../src/shared/audit-issues.ts";

export type SiteId =
  | "main"
  | "llmsbad"
  | "robots500"
  | "robotshtml"
  | "closed"
  | "throttled";

export interface FixtureContext {
  origin: string;
  request: Request;
  path: string;
  site: SiteId;
}

export interface Fixture {
  path: string;
  extraPaths?: string[];
  site?: SiteId;
  name: string;
  category?: string;
  summary?: string;
  expectedIssues: AuditIssueType[];
  support?: boolean;
  inSitemap?: boolean;
  linkedFromCatalog?: boolean;
  handler: (ctx: FixtureContext) => Response | Promise<Response>;
}

export interface SiteConfig {
  id: SiteId;
  host: string;
  expectedSiteIssues: AuditIssueType[];
  robotsText?: string | null;
  llmsTxt?: { status: number; contentType: string; body: string };
  sitemap?: string;
}
