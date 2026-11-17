import { z } from "zod";
import {
  definePricedAction,
  type PricingContext,
  type PricedActionEstimateResult,
} from "../pricedActions.ts";
import { LIGHTHOUSE_LIVE_USD } from "../dataforseo.ts";
import { firecrawlScrapeUsd } from "../firecrawl.ts";

export const siteAuditInput = z.strictObject({
  maxPages: z.int().min(10).max(10_000).default(50),
  lighthouse: z.boolean().default(false),
  renderJavaScript: z.boolean().default(false),
});

export type SiteAuditQuoteDeps = {
  lighthouseUnitUsd?: number;
  firecrawlUnitUsd?: number;
  hasActiveAudit?: (brandKey: string) => Promise<boolean>;
};

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function hasActiveAudit(ctx: PricingContext): Promise<boolean> {
  try {
    const { data, error } = await ctx.admin
      .from("site_audits")
      .select("id")
      .eq("brand_key", ctx.brandKey)
      .in("status", ["queued", "running"])
      .limit(1)
      .maybeSingle();
    return !error && Boolean(data);
  } catch {
    return false;
  }
}

export async function estimateSiteAudit(
  ctx: PricingContext,
  input: z.infer<typeof siteAuditInput>,
  deps?: SiteAuditQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const maxPages = input.maxPages ?? 50;
  const lighthouse = input.lighthouse ?? false;
  const renderJavaScript = input.renderJavaScript ?? false;
  const lighthouseUnitUsd = deps?.lighthouseUnitUsd ?? LIGHTHOUSE_LIVE_USD;
  const firecrawlUnitUsd = deps?.firecrawlUnitUsd ?? firecrawlScrapeUsd(ctx.env);
  const lines: PricedActionEstimateResult["lines"] = [
    {
      label: `Crawl up to ${maxPages} pages`,
      quantity: maxPages,
      unitUsd: 0,
      totalUsd: 0,
    },
  ];
  const units: PricedActionEstimateResult["units"] = [
    { key: "pages", label: "Pages", count: maxPages },
  ];
  const warnings: PricedActionEstimateResult["warnings"] = [
    {
      code: "free_crawl",
      message: "Crawling is free. Only Lighthouse checks and JavaScript rendering cost money.",
    },
  ];

  if (lighthouse) {
    const totalUsd = roundUsd(20 * lighthouseUnitUsd);
    lines.push({
      label: "Lighthouse checks (up to 10 pages, mobile and desktop)",
      quantity: 20,
      unitUsd: lighthouseUnitUsd,
      totalUsd,
    });
    units.push({ key: "lighthouse_checks", label: "Lighthouse checks", count: 20 });
    warnings.push({
      code: "lighthouse_sample",
      message: "Lighthouse runs on up to 10 pages, one per page template, so you may pay for fewer than 20 checks.",
    });
  }

  if (renderJavaScript) {
    const totalUsd = roundUsd(maxPages * firecrawlUnitUsd);
    lines.push({
      label: "Pages loaded by a browser service",
      quantity: maxPages,
      unitUsd: firecrawlUnitUsd,
      totalUsd,
    });
    units.push({ key: "rendered_pages", label: "Rendered pages", count: maxPages });
    warnings.push({
      code: "render_unused",
      message: "You are charged only for pages the browser service loads. Unused reservation is released when the audit ends.",
    });
  }

  let blocked: PricedActionEstimateResult["blocked"] = null;
  const active = deps?.hasActiveAudit
    ? await deps.hasActiveAudit(ctx.brandKey)
    : await hasActiveAudit(ctx);
  if (active) {
    blocked = {
      code: "audit_already_running",
      message: "An audit is already running for this workspace.",
    };
  } else if (renderJavaScript && maxPages > 1_000) {
    blocked = {
      code: "render_page_limit",
      message: "Audits that render JavaScript are limited to 1,000 pages.",
    };
  }

  return {
    totalUsd: roundUsd(lines.reduce((sum, line) => sum + line.totalUsd, 0)),
    expectedUsd: null,
    units,
    lines,
    monthly: null,
    warnings,
    blocked,
  };
}

export const siteAuditAction = definePricedAction({
  key: "site_audit.run",
  feature: "site_audit.render",
  input: siteAuditInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateSiteAudit(ctx, input),
});
