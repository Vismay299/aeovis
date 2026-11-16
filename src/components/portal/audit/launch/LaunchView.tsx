// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/launch/LaunchView.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the launch screen: the page header, the start card, the
// previous-audits table, the large-audit confirmation and the cost dialog.

import { useEffect } from "react";
import { PageHeader } from "@/components/app/PageHeader";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { usePortal } from "@/components/portal/PortalShell";
import { CrawlerAccessCard } from "../crawlerAccess/CrawlerAccessCard";
import { AuditHistoryTable } from "./AuditHistoryTable";
import { LaunchFormCard } from "./LaunchFormCard";
import { useLaunchController } from "./useLaunchController";
import { trackAuditEvent } from "../telemetry";
import { hostOf } from "../shared";

export function LaunchView({ brandKey }: { brandKey: string }) {
  const controller = useLaunchController({ brandKey });
  const { brand, features } = usePortal();
  const websiteHost = hostOf(brand?.website ?? "");
  const crawlerAccessEnabled = features?.site_audit_crawler_access === true;

  useEffect(() => {
    trackAuditEvent("site_audit:launch_open");
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Site Audit"
        description="Crawl your website for technical SEO problems and see what AI crawlers can read."
      />

      <LaunchFormCard
        controller={controller}
        websiteHost={websiteHost}
        renderAvailable={features?.site_audit_render === true}
      />

      {brand?.role === "owner" && crawlerAccessEnabled ? (
        <CrawlerAccessCard
          brandKey={brandKey}
          host={websiteHost}
          enabled={crawlerAccessEnabled}
        />
      ) : null}

      <AuditHistoryTable controller={controller} />

      {controller.confirmPages != null ? (
        <ConfirmDialog
          title="Start a large audit?"
          confirmLabel="Continue"
          onConfirm={controller.confirmLarge}
          onClose={() => {
            /* the controller owns the dialogs; keep the current page */
          }}
        >
          {`You're about to crawl ${controller.confirmPages} pages. At about one page per second this takes about ${controller.estimatedMinutes(
            controller.confirmPages,
          )} minutes. Continue?`}
        </ConfirmDialog>
      ) : null}

      {controller.costOpen ? (
        <CostReviewDialog
          open
          title="Start site audit"
          confirmLabel="Start audit"
          pendingLabel="Starting…"
          quote={controller.quote}
          pending={controller.pending}
          priceChanged={controller.priceChanged}
          error={null}
          onConfirm={controller.confirmCost}
          onClose={controller.closeCost}
        />
      ) : null}
    </div>
  );
}
