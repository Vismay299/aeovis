// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/AuditDetail.tsx, src/client/features/audit/shared.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — one audit: the live progress and feed while it runs, the
// status banners when it stops, and the results once pages exist.

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/app/PageHeader";
import { QueryError } from "@/components/app/QueryState";
import { SkeletonPage } from "@/components/app/SkeletonPresets";
import { usePortal } from "@/components/portal/PortalShell";
import { AUDIT_ERROR_COPY, PHASE_LABELS } from "@/shared/audit";
import { isAuditActive, useAuditStatus } from "./hooks/useAuditStatus";
import { useAuditFeed } from "./hooks/useAuditFeed";
import { useAuditSummary } from "./hooks/useAuditSummary";
import { useCancelAudit } from "./hooks/useCancelAudit";
import { ProgressCard } from "./ProgressCard";
import { CrawlFeed } from "./CrawlFeed";
import { ResultsView } from "./results/ResultsView";
import { StatusBadge, formatAuditDateTime, hostOf } from "./shared";
import { trackAuditEvent } from "./telemetry";
import type { AuditStatusResponse } from "./hooks/useAuditStatus";

function phaseView(audit: AuditStatusResponse): {
  title: string;
  badge: string;
  label: string;
  percent: number | null;
  busy: boolean;
} {
  if (audit.cancelRequested) {
    return {
      title: "Crawling pages",
      badge: "Cancelling…",
      label: `${audit.pagesCrawled} / ${audit.pagesTotal} pages`,
      percent:
        audit.pagesTotal > 0
          ? Math.min(100, Math.round((audit.pagesCrawled / audit.pagesTotal) * 100))
          : null,
      busy: false,
    };
  }
  switch (audit.currentPhase) {
    case "starting":
    case "discovery":
      return {
        title: "Finding pages",
        badge: PHASE_LABELS[audit.currentPhase],
        label: "Reading robots.txt and sitemaps…",
        percent: null,
        busy: true,
      };
    case "crawling":
      return {
        title: "Crawling pages",
        badge: "Crawling",
        label: `${audit.pagesCrawled} / ${audit.pagesTotal} pages`,
        percent:
          audit.pagesTotal > 0
            ? Math.min(
                100,
                Math.round((audit.pagesCrawled / audit.pagesTotal) * 100),
              )
            : null,
        busy: true,
      };
    case "lighthouse":
      return {
        title: "Running Lighthouse checks",
        badge: "Lighthouse",
        label: `${audit.lighthouseCompleted} / ${audit.lighthouseTotal} checks${
          audit.lighthouseFailed > 0
            ? ` (${audit.lighthouseFailed} failed)`
            : ""
        }`,
        percent:
          audit.lighthouseTotal > 0
            ? Math.min(
                100,
                Math.round(
                  (audit.lighthouseCompleted / audit.lighthouseTotal) * 100,
                ),
              )
            : null,
        busy: true,
      };
    case "finalizing":
      return {
        title: "Checking pages",
        badge: "Finalizing",
        label: "Finding duplicates, broken links and orphan pages…",
        percent: null,
        busy: true,
      };
    default:
      return {
        title: "Waiting to start",
        badge: "Queued",
        label: "Your audit starts within a minute.",
        percent: null,
        busy: false,
      };
  }
}

export function AuditDetail({
  brandKey,
  auditId,
}: {
  brandKey: string;
  auditId: string;
}) {
  const { features } = usePortal();
  const statusQuery = useAuditStatus(auditId, brandKey);
  const audit = statusQuery.data;
  const active = isAuditActive(audit);
  const feed = useAuditFeed(auditId, active);
  const summary = useAuditSummary(auditId, Boolean(audit) && !active);
  const cancel = useCancelAudit(brandKey, auditId);
  const [confirmCancel, setConfirmCancel] = useState(false);

  if (statusQuery.isPending) return <SkeletonPage />;
  if (statusQuery.isError || !audit) {
    return (
      <div className="space-y-3">
        <BackLink href="/portal/audit">All audits</BackLink>
        <QueryError
          error={statusQuery.error}
          fallback="We could not load this audit. It may have been deleted."
          onRetry={() => void statusQuery.refetch()}
          isRetrying={statusQuery.isFetching}
        />
      </div>
    );
  }

  const phase = phaseView(audit);
  const errorCopy = audit.errorCode
    ? AUDIT_ERROR_COPY[audit.errorCode] ?? AUDIT_ERROR_COPY.unknown
    : null;
  const showResults = !active && audit.pagesCrawled > 0;

  return (
    <div className="space-y-4">
      <BackLink href="/portal/audit">All audits</BackLink>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {hostOf(audit.startUrl)}
        </h1>
        {!active ? <StatusBadge status={audit.status} /> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {`Site audit · Started ${formatAuditDateTime(
          audit.startedAt ?? audit.createdAt,
        )}`}
        {audit.renderJavaScript ? " · JavaScript rendered" : null}
      </p>

      {active ? (
        <>
          <ProgressCard
            title={phase.title}
            badge={phase.badge}
            label={phase.label}
            percent={phase.percent}
            busy={phase.busy}
            action={
              <Button
                variant="outline"
                size="sm"
                disabled={audit.cancelRequested || cancel.isPending}
                pending={audit.cancelRequested || cancel.isPending}
                onClick={() => {
                  trackAuditEvent("site_audit:cancel");
                  setConfirmCancel(true);
                }}
              >
                Cancel audit
              </Button>
            }
          />
          <CrawlFeed entries={feed.data?.entries ?? []} />
        </>
      ) : null}

      {audit.errorCode === "start_url_off_site" ? (
        <Alert variant="destructive">
          <AlertTitle>{errorCopy?.title}</AlertTitle>
          <AlertDescription>{errorCopy?.body}</AlertDescription>
        </Alert>
      ) : null}

      {audit.status === "failed" && audit.pagesCrawled === 0 ? (
        <Alert variant="destructive">
          <AlertTitle>
            This audit stopped before it crawled any pages.
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              Run a new audit to try again. If it keeps happening, contact
              Perceev support.
            </p>
            {audit.errorCode ? (
              <p className="font-mono text-xs">{`Code: ${audit.errorCode}`}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {audit.status === "failed" && audit.pagesCrawled > 0 ? (
        <Alert variant="warning">
          <AlertTitle>
            {`This audit stopped early after ${audit.pagesCrawled} page(s).`}
          </AlertTitle>
          <AlertDescription>
            The results below cover everything crawled before it stopped. Run a
            new audit to try again.
          </AlertDescription>
        </Alert>
      ) : null}

      {audit.status === "cancelled" ? (
        <Alert>
          <AlertTitle>
            {audit.pagesCrawled > 0
              ? `You cancelled this audit after ${audit.pagesCrawled} page(s).`
              : "You cancelled this audit before it crawled any pages."}
          </AlertTitle>
          {audit.pagesCrawled > 0 ? (
            <AlertDescription>
              The results below cover what was crawled before you cancelled.
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      {showResults ? (
        <ResultsView
          brandKey={brandKey}
          auditId={auditId}
          summary={summary}
          canRender={features?.site_audit_render === true}
        />
      ) : null}

      <AlertDialog
        open={confirmCancel}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) setConfirmCancel(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this audit?</AlertDialogTitle>
            <AlertDialogDescription>
              Pages crawled so far stay in the report. Checks already paid for
              are still charged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancel.isPending}>
              Keep running
            </AlertDialogCancel>
            <Button
              variant="destructive"
              pending={cancel.isPending}
              onClick={() =>
                cancel.mutate(undefined, {
                  onSettled: () => setConfirmCancel(false),
                })
              }
            >
              Cancel audit
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
