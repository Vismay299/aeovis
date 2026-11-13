import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZodType } from "zod";
import { workspaceAnswersKind } from "./workspaceAnswers.ts";
import {
  siteAuditIssuesKind,
  siteAuditPagesKind,
  siteAuditPerformanceKind,
} from "./siteAudit.ts";

/**
 * One server-side export kind (F06 §6.2).
 *
 * `params` is strict: the route hands it raw request params and the registry
 * validates them before any row is inserted. `load` must scope every query by
 * `brandKey`; it never receives a customer-scoped client.
 */
export type ExportKind<P> = {
  kind: string;
  feature: string; // telemetry source_feature and filename part
  params: ZodType<P>; // strict
  maxRows: number; // 50_000 for workspace_answers
  load(
    admin: SupabaseClient,
    brandKey: string,
    params: P,
  ): Promise<{ rows: Record<string, unknown>[]; meta: Record<string, unknown> }>;
  csvHeaders: readonly string[];
  toCsvRow(row: Record<string, unknown>): (string | number | boolean | null)[];
  toJson(
    rows: Record<string, unknown>[],
    meta: Record<string, unknown>,
    ctx: { brandKey: string; exportedAt: string },
  ): unknown;
  filename(brandKey: string, params: P, format: "csv" | "json"): string;
};

/**
 * Registered kinds. Keeping registration behind these two functions keeps
 * `kinds/index.ts` the single place the next kind (F18's site audit) is wired
 * in, without a route or registry change.
 */
export const EXPORT_KINDS: Record<string, ExportKind<unknown>> = {
  workspace_answers: workspaceAnswersKind as ExportKind<unknown>,
  site_audit_issues: siteAuditIssuesKind as ExportKind<unknown>,
  site_audit_pages: siteAuditPagesKind as ExportKind<unknown>,
  site_audit_performance: siteAuditPerformanceKind as ExportKind<unknown>,
};

export function registerExportKind<P>(kind: ExportKind<P>): void {
  EXPORT_KINDS[kind.kind] = kind as ExportKind<unknown>;
}

export function getExportKind(name: string): ExportKind<unknown> | null {
  return EXPORT_KINDS[name] ?? null;
}
