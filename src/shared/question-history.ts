// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/PromptDateRange.tsx
//   src/client/features/ai-visibility/shared.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";

export const HISTORY_RANGES = ["last_7_days", "last_28_days", "last_90_days", "all", "custom"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

export const HISTORY_RANGE_LABELS: Record<HistoryRange, string> = {
  last_7_days: "Last 7 days",
  last_28_days: "Last 28 days",
  last_90_days: "Last 90 days",
  all: "All available history",
  custom: "Custom range",
};

export type HistoryPeriod = { preset: HistoryRange; start: string; end: string };

export const HISTORY_MAX_EXECUTIONS = 500;
export const ANSWER_DISPLAY_LIMIT = 24_000;

function toLocalDateString(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function historyPeriod(preset: HistoryRange = "last_28_days", now: Date = new Date()): HistoryPeriod {
  if (preset === "all") return { preset, start: "", end: "" };
  if (preset === "custom") return { preset, start: "", end: "" };
  const days = preset === "last_7_days" ? 7 : preset === "last_90_days" ? 90 : 28;
  const endDate = now instanceof Date ? now : new Date(now);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days + 1);
  return { preset, start: toLocalDateString(startDate), end: toLocalDateString(endDate) };
}

function localDayStartIso(dateStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function localDayEndIso(dateStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const start = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const exclusive = new Date(start);
  exclusive.setDate(exclusive.getDate() + 1);
  return new Date(exclusive.getTime() - 1).toISOString();
}

export function periodToQuery(period: HistoryPeriod): { from?: string; to?: string } | null {
  if (period.preset === "all") return {};
  const start = period.start || "";
  const end = period.end || "";
  if (!start || !end) return null;
  if (start > end) return null;
  const from = localDayStartIso(start);
  const to = localDayEndIso(end);
  if (!from || !to) return null;
  return { from, to };
}

export const executionSchema = z.looseObject({
  answerId: z.uuid(),
  source: z.enum(["scan", "explore", "legacy"]),
  engine: z.string(),
  engineLabel: z.string(),
  collectedAt: z.iso.datetime(),
  trigger: z.enum(["manual", "scheduled", "explore", "legacy"]),
  status: z.enum(["answered", "no_answer", "failed", "blocked", "unknown"]),
  ownMentioned: z.boolean().nullable(),
  ownCited: z.boolean().nullable(),
  askedText: z.string(),
  scanId: z.uuid().nullable(),
  exploreRunId: z.uuid().nullable(),
  method: z.enum(["consumer_capture", "model_api", "google_serp", "unknown"]),
  quality: z.enum(["measured", "legacy_unknown"]),
});

export const brandSummarySchema = z.looseObject({
  name: z.string(),
  isSelf: z.boolean(),
  answers: z.number().int().min(0),
  mentions: z.number().int().min(0),
  unknown: z.number().int().min(0),
  citations: z.number().int().min(0),
});

export function excerpt(
  text: string,
  span: { start: number; end: number },
  radius = 70,
): { before: string; match: string; after: string } {
  const value = typeof text === "string" ? text : "";
  let start = Math.floor(Number(span?.start));
  let end = Math.floor(Number(span?.end));
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = start;
  start = Math.max(0, Math.min(start, value.length));
  end = Math.max(start, Math.min(end, value.length));

  const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
  const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

  let beforeStart = Math.max(0, start - radius);
  const beforeStartCode = value.charCodeAt(beforeStart);
  if (beforeStart > 0 && Number.isFinite(beforeStartCode) && isLowSurrogate(beforeStartCode)) {
    const prev = value.charCodeAt(beforeStart - 1);
    if (isHighSurrogate(prev)) beforeStart += 1;
  }
  let afterEnd = Math.min(value.length, end + radius);
  if (afterEnd < value.length) {
    const atEnd = value.charCodeAt(afterEnd - 1);
    const next = value.charCodeAt(afterEnd);
    if (isHighSurrogate(atEnd) && isLowSurrogate(next)) afterEnd += 1;
  }

  let matchStart = start;
  let matchEnd = end;
  if (matchStart > 0 && matchStart < value.length) {
    const code = value.charCodeAt(matchStart);
    if (isLowSurrogate(code)) {
      const prev = value.charCodeAt(matchStart - 1);
      if (isHighSurrogate(prev)) matchStart -= 1;
    }
  }
  if (matchEnd > 0 && matchEnd < value.length) {
    const prev = value.charCodeAt(matchEnd - 1);
    const code = value.charCodeAt(matchEnd);
    if (isHighSurrogate(prev) && isLowSurrogate(code)) matchEnd += 1;
  }

  return {
    before: value.slice(beforeStart, matchStart),
    match: value.slice(matchStart, matchEnd),
    after: value.slice(matchEnd, afterEnd),
  };
}
