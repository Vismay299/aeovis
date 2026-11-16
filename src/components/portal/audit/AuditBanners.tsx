// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/ResultsView.tsx, src/client/features/audit/RenderingWarnings.tsx, src/client/features/audit/shared.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the result banners: bot protection, robots, rate limits,
// abandoned pages, truncated discovery, app shells, unread pages and an
// incomplete link graph.

import { ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { AuditSummary } from "./hooks/useAuditSummary";
import { BotProtectionAdvice } from "./shared";
import { ShopifyCrawlWarning } from "./crawlerAccess/ShopifyCrawlWarning";

export function AuditBanners({
  summary,
  canRender,
  brandKey,
  host,
  isOwner,
  crawlerAccessEnabled,
}: {
  summary: AuditSummary;
  canRender: boolean;
  brandKey: string;
  host: string;
  isOwner: boolean;
  crawlerAccessEnabled: boolean;
}) {
  const { audit, stats, issueGroups, flags } = summary;
  const rendered = Boolean(audit.renderJavaScript);
  const hasRobotsBlock = issueGroups.some(
    (group) => group.issueType === "crawl-blocked-by-robots",
  );
  // F18 phase 9 — a Shopify audit limited by the store gets one Shopify-specific
  // notice in place of the four generic bot/rate-limit banners below.
  const shopifyWarning =
    crawlerAccessEnabled &&
    audit.sitePlatform === "shopify" &&
    (flags.siteBlocked ||
      stats.pagesBlocked > 0 ||
      flags.crawlStopped ||
      stats.pagesRateLimited > 0);

  const banners: Array<{
    key: string;
    variant: "destructive" | "warning";
    title: string;
    body: React.ReactNode;
  }> = [];

  if (!shopifyWarning && flags.siteBlocked) {
    banners.push({
      key: "site-blocked",
      variant: "destructive",
      title: "This site's bot protection blocked our crawler.",
      body: <BotProtectionAdvice rendered={rendered} canRender={canRender} />,
    });
  }

  if (hasRobotsBlock) {
    banners.push({
      key: "robots-blocked",
      variant: "destructive",
      title:
        "robots.txt blocks crawlers from your homepage, so we couldn't audit it.",
      body:
        "Remove or narrow the rule in the `User-agent: *` group that disallows `/`, then run the audit again.",
    });
  }

  if (!shopifyWarning && stats.pagesBlocked > 0 && !flags.siteBlocked) {
    banners.push({
      key: "pages-blocked",
      variant: "warning",
      title: `Bot protection blocked our crawler on ${stats.pagesBlocked} page(s).`,
      body: <BotProtectionAdvice rendered={rendered} canRender={canRender} />,
    });
  }

  if (!shopifyWarning && flags.crawlStopped) {
    banners.push({
      key: "crawl-stopped",
      variant: "warning",
      title: "The crawl stopped early because of the site's rate limit.",
      body:
        "The requested cooldown was longer than the audit allows, so some URLs were left unvisited. This report is incomplete. Run the audit again after the limit resets, or ask the site owner to allow the PerceevAudit crawler.",
    });
  }

  if (!shopifyWarning && stats.pagesRateLimited > 0 && !flags.crawlStopped) {
    banners.push({
      key: "rate-limited",
      variant: "warning",
      title: `The site rate limited us on ${stats.pagesRateLimited} page(s).`,
      body:
        "Pages that returned 429 Too Many Requests could not be audited. Run the audit again after the limit resets, or ask the site owner to allow the PerceevAudit crawler.",
    });
  }

  if (stats.pagesAbandoned > 0) {
    banners.push({
      key: "abandoned",
      variant: "warning",
      title: `${stats.pagesAbandoned} page(s) weren't crawled because a crawl step failed.`,
      body:
        "We never repeat a paid page load, so these pages were skipped. Run a new audit to include them.",
    });
  }

  if (flags.discoveryTruncated) {
    banners.push({
      key: "discovery-truncated",
      variant: "warning",
      title: "We stopped reading sitemaps after 150 seconds.",
      body:
        "Some pages listed only in your sitemaps may be missing from this audit.",
    });
  }

  if (flags.hasShells) {
    banners.push({
      key: "app-shells",
      variant: "warning",
      title: "Some pages may need JavaScript to show their content.",
      body: rendered
        ? "They were still loading after rendering, so we couldn't check them."
        : "Turn on Render JavaScript and run the audit again to check them.",
    });
  }

  if (rendered && stats.pagesUnread > 0) {
    banners.push({
      key: "unread",
      variant: "warning",
      title: `We couldn't read ${stats.pagesUnread} page(s).`,
      body:
        "To see them, open Pages and filter Crawl result by Failed.",
    });
  }

  if (!flags.linkGraphComplete) {
    banners.push({
      key: "link-graph",
      variant: "warning",
      title: "This site has more internal links than we store.",
      body: "Orphan pages weren't checked in this audit.",
    });
  }

  if (!shopifyWarning && banners.length === 0) return null;

  return (
    <div className="space-y-2">
      {shopifyWarning ? (
        <ShopifyCrawlWarning
          brandKey={brandKey}
          host={host}
          isOwner={isOwner}
          enabled={crawlerAccessEnabled}
        />
      ) : null}
      {banners.map((banner) => (
        <Alert key={banner.key} variant={banner.variant}>
          <ShieldAlert aria-hidden />
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.body}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
