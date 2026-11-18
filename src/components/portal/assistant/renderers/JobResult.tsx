"use client";

import { Spinner } from "@/components/ui/spinner";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A running or finished background job (scan, audit, explore run): status
 * line, determinate progress when the tool reports counts, and the completed
 * model count for explore runs.
 */
export function JobResult({ data }: { data: unknown }) {
  const record = asRecord(data);
  const status = typeof record.status === "string" ? record.status : "unknown";
  const progressPct = asNumber(record.progressPct);
  const crawled = asNumber(record.pagesCrawled);
  const total = asNumber(record.pagesTotal);
  const completedModels = asNumber(record.completedModels);
  const ratio =
    progressPct !== null
      ? Math.min(100, Math.max(0, progressPct))
      : crawled !== null && total !== null && total > 0
        ? Math.min(100, Math.max(0, (crawled / total) * 100))
        : null;
  const running = status !== "completed" && status !== "complete" && status !== "failed" && status !== "error";

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm">
        {running ? <Spinner className="size-3.5" /> : null}
        <span className="font-medium capitalize">{status.replaceAll("_", " ")}</span>
        {crawled !== null && total !== null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {crawled.toLocaleString("en-US")} / {total.toLocaleString("en-US")} pages
          </span>
        ) : null}
        {completedModels !== null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {completedModels} model{completedModels === 1 ? "" : "s"} done
          </span>
        ) : null}
      </p>
      {ratio !== null ? (
        <div
          className="h-2 overflow-hidden rounded-full bg-foreground/10"
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio)}
        >
          <div className="h-full bg-primary" style={{ width: `${ratio}%` }} />
        </div>
      ) : null}
    </div>
  );
}
