"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  TOOL_PRESENTATION,
  autoTable,
  humanizeToolName,
  type RenderSpec,
} from "@/shared/assistant-tools";
import { TableResult } from "./renderers/TableResult.tsx";
import { KeyValueResult } from "./renderers/KeyValueResult.tsx";
import { UntrustedText } from "./renderers/UntrustedText.tsx";
import { JobResult } from "./renderers/JobResult.tsx";
import { ContextResult } from "./renderers/ContextResult.tsx";
import { SkillResult } from "./renderers/SkillResult.tsx";
import { JsonResult } from "./renderers/JsonResult.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { toToolPartView, type ToolPartView } from "./toolPartView.ts";

// ---------------------------------------------------------------------------
// The card reads the backend's TOOL_PRESENTATION (P5.T1): titles, running and
// done copy, and the RenderSpec per tool. Two frontend-only refinements live
// here, because they are about layout rather than tool meaning:
// - `read_pages` renders one UntrustedText per page with its URL heading
//   (F22 §6.6.1), instead of the single `pages[*].text` text spec.
// - text bodies get a small source label ("Answer") for the untrusted block.
// ---------------------------------------------------------------------------

function textLabel(toolName: string, path: string): string {
  if (toolName === "get_scan_answer" || toolName === "get_question_answer") return "Answer";
  const last = path
    .split(".")
    .pop()
    ?.replace(/\[\*\]$/, "");
  if (!last) return "Details";
  return humanizeToolName(last);
}

type Envelope =
  | { status: "success"; summary: string; data: unknown; link: { path: string; label: string } | null; untrusted: string[]; truncated: string | null }
  | { status: "awaiting_approval"; approvalId: string; kind: "price" | "confirm"; label: string; quote: unknown; expiresAt: string; summary: string }
  | { status: "error"; code: string; message: string; recovery: string | null };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asEnvelope(value: unknown): Envelope | null {
  const record = asRecord(value);
  if (record.status === "success" || record.status === "awaiting_approval" || record.status === "error") {
    return value as Envelope;
  }
  return null;
}

export { toToolPartView, type ToolPartView } from "./toolPartView.ts";

// Column keys the backend spec disagrees with the runtime tool output on.
// `assistant_gsc_query_summary` (migration 148) selects `avg_position`, but
// the tool maps it to `position` (own/searchConsole.ts:95) before returning —
// the output key is what the card receives.
const COLUMN_KEY_FIXES: Record<string, Record<string, string>> = {
  get_search_console_performance: { avg_position: "position" },
};

function dottedPath(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, data);
}

function inferFormat(key: string): "int" | "usd" | "pct" | "position" | "date" | "url" | "text" {
  const lower = key.toLowerCase();
  if (lower.includes("usd") || lower.includes("price") || lower.includes("cost") || lower === "cpc") return "usd";
  if (lower.includes("pct") || lower.includes("percent") || lower === "ctr" || lower.includes("rate") || lower.includes("share") || lower.includes("visibility")) return "pct";
  if (lower.includes("position")) return "position";
  if (lower.includes("date") || lower.endsWith("at") || lower.includes("time")) return "date";
  if (lower.includes("url") || lower.includes("link")) return "url";
  if (lower.includes("rank") || lower.includes("count") || lower.includes("clicks") || lower.includes("impressions") || lower.includes("volume") || lower.includes("pages") || lower.includes("questions") || lower === "difficulty") return "int";
  return "text";
}

/**
 * One tool call inside an assistant message: running progress, the finished
 * data card, the approval card, or the typed error. Reasoning never renders
 * here — the model loop's thinking is not streamed to the UI.
 */
export function ToolResultCard({
  part,
  live,
  openData,
  brandKey,
  onApprovalDecided,
}: {
  part: unknown;
  /** True while the reply is still streaming: running parts spin, and an
   * unfinished part is still in flight rather than interrupted. */
  live: boolean;
  /** Open "Show data" by default (the last tool card of a reply). */
  openData?: boolean;
  brandKey: string;
  onApprovalDecided?: (approvalId: string) => void;
}) {
  const [dataOpen, setDataOpen] = useState(Boolean(openData));
  const view = toToolPartView(part);
  if (!view) return null;
  const presentation = TOOL_PRESENTATION[view.toolName];
  const title = presentation?.title ?? humanizeToolName(view.toolName);
  const doneText = presentation?.done ?? title;
  const runningText = presentation?.running ?? `${title}…`;

  const isDone = view.state === "output-available";
  const hasOutput = view.output !== undefined;
  // A running part in a message that is no longer being generated never
  // finished — the turn was interrupted. Show it as failed, not spinning.
  const isErrorState = view.state === "output-error" || (!isDone && !live);
  const isRunning = !isErrorState && !isDone;

  if (isRunning) {
    return (
      <div className="rounded-xl border border-border bg-card px-3 py-2 text-sm">
        <p className="flex items-center gap-2">
          <Spinner className="size-3.5" />
          <span className="font-medium">{runningText}</span>
        </p>
      </div>
    );
  }

  if (view.state === "output-error" || (!isDone && !live && !hasOutput)) {
    const message =
      view.state === "output-error"
        ? (view.errorText || "The tool failed.")
        : "This step did not finish.";
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm">
        <p className="flex items-center gap-2 font-medium text-destructive">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <span>Couldn't {title.charAt(0).toLowerCase() + title.slice(1)}</span>
        </p>
        <p className="mt-1 text-sm">{message}</p>
      </div>
    );
  }

  const envelope = asEnvelope(view.output);
  // A finished part whose output is not an envelope (or an envelope we do not
  // recognise) still shows its summary line rather than disappearing.
  if (!envelope) {
    return (
      <div className="rounded-xl border border-border bg-card px-3 py-2 text-sm">
        <p className="flex items-center gap-2">
          <Check className="size-4 shrink-0 text-success" aria-hidden />
          <span className="font-medium">{doneText}</span>
        </p>
      </div>
    );
  }

  if (envelope.status === "awaiting_approval") {
    return (
      <ApprovalCard
        brandKey={brandKey}
        approvalId={envelope.approvalId}
        kind={envelope.kind}
        label={envelope.label}
        quote={envelope.quote}
        expiresAt={envelope.expiresAt}
        toolInput={view.input}
        focusOnMount={live}
        onDecided={onApprovalDecided}
      />
    );
  }

  if (envelope.status === "error") {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm">
        <p className="flex items-center gap-2 font-medium text-destructive">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <span>Couldn't {title.charAt(0).toLowerCase() + title.slice(1)}</span>
        </p>
        <p className="mt-1 text-sm">{envelope.message}</p>
        {envelope.recovery ? (
          <p className="mt-1 text-xs text-muted-foreground">{envelope.recovery}</p>
        ) : null}
      </div>
    );
  }

  const untrusted = Array.isArray(envelope.untrusted)
    ? envelope.untrusted.filter((entry): entry is string => typeof entry === "string")
    : [];
  const spec: RenderSpec = presentation?.render ?? { kind: "auto" };
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2 text-sm">
      <p className="flex items-center gap-2">
        <Check className="size-4 shrink-0 text-success" aria-hidden />
        <span className="font-medium">{doneText}</span>
      </p>
      {envelope.summary ? (
        <p className="mt-1 text-sm text-muted-foreground">{envelope.summary}</p>
      ) : null}
      <div className="mt-2">
        {renderBody(spec, view.toolName, envelope.data, untrusted, view)}
      </div>
      {envelope.truncated ? (
        <p className="mt-1.5 text-xs text-muted-foreground">…{envelope.truncated}</p>
      ) : null}
      {spec.kind === "skill" || spec.kind === "job" ? null : (
        <Collapsible open={dataOpen} onOpenChange={setDataOpen} className="mt-1.5">
          <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            <ChevronRight className="size-3 transition-transform group-data-panel-open:rotate-90" aria-hidden />
            <span>Show data</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5">
            <JsonResult data={envelope.data} />
          </CollapsibleContent>
        </Collapsible>
      )}
      {envelope.link ? (
        <p className="mt-1.5 text-xs">
          <Link href={envelope.link.path} className="text-primary underline-offset-4 hover:underline">
            {envelope.link.label} →
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function renderBody(
  spec: RenderSpec,
  toolName: string,
  data: unknown,
  untrusted: readonly string[],
  view: ToolPartView,
) {
  switch (spec.kind) {
    case "table": {
      const record = asRecord(data);
      const rows = Array.isArray(record[spec.rowsPath]) ? (record[spec.rowsPath] as unknown[]) : [];
      const total =
        spec.totalPath && typeof record[spec.totalPath] === "number"
          ? (record[spec.totalPath] as number)
          : null;
      const fixes = COLUMN_KEY_FIXES[toolName] ?? {};
      const columns = spec.columns.map((column) => ({
        ...column,
        key: fixes[column.key] ?? column.key,
      }));
      return (
        <TableResult rows={rows} columns={columns} totalCount={total} untrusted={untrusted} basePath={spec.rowsPath} />
      );
    }
    case "keyValue":
      return <KeyValueResult data={data} fields={spec.fields} untrusted={untrusted} />;
    case "text": {
      // `read_pages` carries one text per page with its URL heading.
      if (toolName === "read_pages") {
        const pages = asRecord(data).pages;
        if (!Array.isArray(pages) || pages.length === 0) return <JsonResult data={data} />;
        return (
          <div className="space-y-2">
            {pages.slice(0, 20).map((page, index) => {
              const record = asRecord(page);
              const url = typeof record.url === "string" ? record.url : "";
              const title = typeof record.title === "string" ? record.title : "";
              const text = typeof record.text === "string" ? record.text : "";
              return (
                <div key={index} className="space-y-1">
                  {url || title ? (
                    <p className="text-xs font-medium break-all">
                      {url || title}
                      {url && title ? <span className="font-normal text-muted-foreground"> — {title}</span> : null}
                    </p>
                  ) : null}
                  {text ? <UntrustedText label="Page text" text={text} /> : null}
                </div>
              );
            })}
          </div>
        );
      }
      const text = dottedPath(data, spec.path);
      return typeof text === "string" && text ? (
        <UntrustedText label={textLabel(toolName, spec.path)} text={text} />
      ) : (
        <JsonResult data={data} />
      );
    }
    case "job":
      return <JobResult data={data} />;
    case "context":
      return <ContextResult data={data} />;
    case "skill": {
      const record = asRecord(data);
      const inputName = typeof view.input.name === "string" ? view.input.name : "";
      return (
        <SkillResult
          name={typeof record.name === "string" ? record.name : inputName}
          title={typeof record.title === "string" ? record.title : undefined}
          version={typeof record.version === "string" ? record.version : undefined}
        />
      );
    }
    case "auto": {
      const result = autoTable(data);
      if (result.kind === "table") {
        if (result.columns.length === 0) return <JsonResult data={data} />;
        return (
          <TableResult
            rows={result.rows}
            columns={result.columns.map((column) => ({ ...column, format: inferFormat(column.key) }))}
            totalCount={result.total}
            untrusted={untrusted}
          />
        );
      }
      if (result.kind === "keyValue") {
        return (
          <KeyValueResult
            data={Object.fromEntries(result.entries.map((entry) => [entry.key, entry.value]))}
            fields={result.entries.map((entry) => ({ key: entry.key, label: entry.label, format: inferFormat(entry.key) }))}
            untrusted={untrusted}
          />
        );
      }
      return <JsonResult data={result.value} />;
    }
  }
}
