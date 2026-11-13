// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/shared.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — small presentational helpers shared by the audit screens:
// status/severity/HTTP badges, score and number formatting, date formatting
// and the bot-protection advice copy.

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AuditStatus } from "@/shared/audit";
import type { IssueSeverity } from "@/shared/audit-issues";

type BadgeVariant =
  | "default"
  | "soft"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info"
  | "ghost"
  | "link";

const STATUS_META: Record<
  AuditStatus,
  { label: string; variant: BadgeVariant }
> = {
  queued: { label: "Queued", variant: "outline" },
  running: { label: "Running", variant: "info" },
  completed: { label: "Done", variant: "success" },
  partial: { label: "Partial", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

export function StatusBadge({
  status,
  className,
}: {
  status: AuditStatus;
  className?: string;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.queued;
  return (
    <Badge variant={meta.variant} className={className}>
      {status === "running" ? (
        <Loader2 aria-hidden className="animate-spin" />
      ) : null}
      {meta.label}
    </Badge>
  );
}

export function PhaseBadge({ label }: { label: string }) {
  return <Badge variant="outline">{label}</Badge>;
}

const SEVERITY_META: Record<
  IssueSeverity,
  { label: string; variant: BadgeVariant }
> = {
  critical: { label: "Critical", variant: "destructive" },
  warning: { label: "Warning", variant: "warning" },
  info: { label: "Info", variant: "outline" },
};

export function SeverityBadge({
  severity,
  count,
}: {
  severity: IssueSeverity;
  count?: number;
}) {
  const meta = SEVERITY_META[severity] ?? SEVERITY_META.info;
  return (
    <Badge variant={meta.variant}>
      {meta.label}
      {typeof count === "number" ? (
        <span className="tabular-nums"> ({count})</span>
      ) : null}
    </Badge>
  );
}

export function HttpStatusBadge({
  statusCode,
  fetchClass,
}: {
  statusCode: number | null;
  fetchClass?: string;
}) {
  if (fetchClass === "blocked") {
    return <Badge variant="warning">Blocked</Badge>;
  }
  if (fetchClass === "rate_limited") {
    return <Badge variant="warning">Rate limited</Badge>;
  }
  if (fetchClass === "error" || statusCode === null || statusCode === 0) {
    return <Badge variant="destructive">Failed</Badge>;
  }
  const variant: BadgeVariant =
    statusCode >= 400
      ? "destructive"
      : statusCode >= 300
        ? "info"
        : "success";
  return <Badge variant={variant}>{statusCode}</Badge>;
}

/** ≥ 90 good, 50–89 needs work, < 50 poor; null is "—", never 0. */
export function scoreClass(score: number | null | undefined): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 90) return "text-success";
  if (score >= 50) return "text-warning-foreground";
  return "text-destructive";
}

export function formatScore(score: number | null | undefined): string {
  return score == null ? "—" : String(Math.round(score));
}

export function formatMs(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${Math.round(value).toLocaleString("en-US")} ms`;
}

export function formatSeconds(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value.toFixed(2)} s`;
}

export function formatCls(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toFixed(2);
}

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatAuditDate(value: string | null | undefined): string {
  const date = parseDate(value);
  return date ? DATE.format(date) : "—";
}

export function formatAuditDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  return date ? DATE_TIME.format(date) : "—";
}

export function formatClockTime(value: string | null | undefined): string {
  const date = parseDate(value);
  return date ? TIME.format(date) : "—";
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function pathOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** The advice shown when a site's bot protection blocks the crawler. */
export function BotProtectionAdvice({
  rendered,
  canRender,
}: {
  rendered: boolean;
  canRender: boolean;
}) {
  const base =
    'Allow the PerceevAudit user agent in your firewall or bot-protection settings (on Cloudflare: a WAF custom rule that skips bot protection when the user agent contains "PerceevAudit"), then run the audit again.';
  return (
    <>
      {rendered ? `Rendering couldn't get past it. ${base}` : base}
      {!rendered && canRender
        ? " Or turn on Render JavaScript and run it again."
        : null}
    </>
  );
}

export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <span className="font-medium">{label}:</span>
      <span className="text-muted-foreground">{children}</span>
    </div>
  );
}
