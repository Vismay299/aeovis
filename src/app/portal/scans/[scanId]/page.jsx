"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { usePortal } from "@/components/portal/PortalShell";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  SkeletonRows,
  Stat,
  formatDate,
} from "@/components/portal/ui";
import {
  CompetitorsCard,
  EngineScoresCard,
  QuestionsCard,
} from "@/components/portal/scans/ReportCards";
import {
  customerReportQuality,
  finiteNumber,
  readCompetitors,
  readEngineScores,
  roundedPct,
} from "@/components/portal/scans/reportData";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { useDebouncedDraft } from "@/components/app/hooks/useDebouncedDraft";
import { scanReportQueryOptions } from "@/lib/query/portalQueries";
import { isApiError } from "@/lib/query/fetchJson";
import { describeError } from "@/lib/query/errors";
import "@/components/portal/scans/scans.css";

const questionFiltersSchema = z.object({
  view: z.enum(["all", "naming", "missing", "unanswered"]),
  q: z.string().max(200),
  engine: z.string().max(40),
});

function KpiSkeleton() {
  return (
    <Card aria-hidden="true">
      <Skeleton width={96} height={11} />
      <Skeleton width={72} height={26} style={{ marginTop: 8 }} />
    </Card>
  );
}

export default function ScanReportPage() {
  const params = useParams();
  const scanId = typeof params?.scanId === "string" ? params.scanId : "";
  usePortal();

  const query = useQuery(scanReportQueryOptions(scanId));

  const [filters, setFilters] = useUrlSearchState(questionFiltersSchema, {
    view: "all",
    q: "",
    engine: "all",
  });
  const [search, setSearch] = useDebouncedDraft(filters.q, (q) => setFilters({ q }));

  const notFound =
    !scanId || (isApiError(query.error) && query.error.status === 404);

  const report = query.data ?? null;
  const scan = report?.scan || null;
  const loading = query.isPending && !scan;

  const results = useMemo(
    () => (Array.isArray(report?.results) ? report.results : []),
    [report]
  );
  const engineRows = useMemo(
    () => (scan ? readEngineScores(scan.engine_scores, scan.engines) : []),
    [scan]
  );
  const competitorRows = useMemo(
    () =>
      scan
        ? readCompetitors({
            competitors: scan.competitors,
            engines: scan.engines,
            brand: scan.brand,
          }).rows
        : [],
    [scan]
  );
  const showEngines = engineRows.length > 0;
  const showCompetitors = competitorRows.length > 0;

  const tracked = finiteNumber(scan?.prompts_tracked);
  const mentioned = finiteNumber(scan?.prompts_mentioned);
  const quality = customerReportQuality(scan);
  const outcome = quality.outcome;

  function downloadMeasurement() {
    const link = document.createElement("a");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })
    );
    link.href = url;
    link.download = `measurement-${scan.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (notFound) {
    return (
      <div className="space-y-6">
        <PageHeader
          backLink={
            <a
              href="/portal/scans"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              All scans
            </a>
          }
          title="Scan report"
        />
        <Card>
          <EmptyState
            title="Scan not found"
            action={
              <Button variant="secondary" href="/portal/scans" icon={ArrowLeft}>
                Back to scans
              </Button>
            }
          >
            This scan does not exist, or it belongs to a workspace you cannot open.
          </EmptyState>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        backLink={
          <a
            href="/portal/scans"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            All scans
          </a>
        }
        eyebrow={
          scan
            ? formatDate(scan.scanned_at || scan.created_at, { withTime: true })
            : undefined
        }
        title="Scan report"
        description={scan?.url || undefined}
      />

      <div className="space-y-6">
        {scan ? (
          <div
            data-testid="customer-collection-outcome"
            className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <Banner
              tone={
                outcome.outcome === "failed"
                  ? "error"
                  : outcome.outcome === "complete"
                  ? "success"
                  : outcome.outcome === "legacy"
                  ? "info"
                  : "warn"
              }
              title={`Collection: ${outcome.outcome}`}
              className="flex-1"
            >
              {outcome.outcome === "legacy"
                ? "Historical collection quality is unknown; no modern qualification is inferred."
                : `${outcome.counts.valid} of ${outcome.counts.planned} valid observations: ${outcome.counts.answered} answered, ${outcome.counts.valid_no_aio} valid without AIO, ${outcome.counts.failed} failed, ${outcome.counts.not_attempted} not attempted. Diagnostics: ${outcome.counts.diagnostics}.`}
            </Banner>
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadMeasurement}
              className="shrink-0"
            >
              Download measurement JSON
            </Button>
          </div>
        ) : null}

        {query.isError ? (
          <Banner
            tone="error"
            title="Report did not load"
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => query.refetch()}
              >
                Retry
              </Button>
            }
          >
            {describeError(query.error, "Could not load the scan report.")}
          </Banner>
        ) : null}

        {scan &&
        Object.values(scan.engines || {}).some((engine) =>
          engine?.metrics?.observed_exposure
            ? engine.metrics.observed_exposure.qualified !== true
            : engine?.data_source_issue ||
              engine?.insufficient_sample ||
              Number(engine?.errored_queries) > 0
        ) ? (
          <Banner tone="warn" title="Collection or sample needs attention">
            Some observations could not be collected or did not meet the minimum evidence needed for a headline. Review each engine's counts and quality notes; missing work is not a measured absence.
          </Banner>
        ) : null}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {loading ? (
            <>
              <KpiSkeleton />
              <KpiSkeleton />
              <KpiSkeleton />
              <KpiSkeleton />
            </>
          ) : (
            <>
              <Stat
                label="AI visibility"
                value={roundedPct(quality.headline)}
                suffix="%"
              />
              <Stat
                label="Answers naming you"
                value={mentioned}
                sub={tracked !== null ? `of ${tracked} questions` : undefined}
              />
              <Stat
                label="Share of voice"
                value={roundedPct(quality.share)}
                suffix="%"
              />
              <Stat
                label="Citation share"
                value={roundedPct(quality.citation)}
                suffix="%"
              />
            </>
          )}
        </div>

        {scan && (showEngines || showCompetitors) ? (
          <div
            className={
              showEngines && showCompetitors
                ? "grid gap-5 lg:grid-cols-2"
                : "space-y-6"
            }
          >
            {showEngines ? (
              <EngineScoresCard
                engineScores={scan.engine_scores}
                engines={scan.engines}
                terminalOutcome={outcome}
              />
            ) : null}
            {showCompetitors ? (
              <CompetitorsCard
                competitors={scan.competitors}
                engines={scan.engines}
                brand={scan.brand}
              />
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <Card title="Questions" flush>
            <SkeletonRows rows={5} />
          </Card>
        ) : scan ? (
          <QuestionsCard
            results={results}
            planned={scan?.planned_questions}
            filters={{ view: filters.view, search, engine: filters.engine }}
            onFiltersChange={(p) => {
              if ("search" in p) setSearch(p.search);
              else
                setFilters({
                  view: p.view ?? filters.view,
                  engine: p.engine ?? filters.engine,
                });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
