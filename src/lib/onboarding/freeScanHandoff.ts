import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeHandoffDomain, normalizeScanId } from "../../shared/auth-redirect.ts";
import {
  canonicalQuestionText,
  normalizeQuestionText,
  addWorkspaceQuestion as defaultAddWorkspaceQuestion,
} from "../questions/workspaceQuestions.ts";
import { AppError } from "../http/appError.ts";

export type Prefill = {
  website: string;
  brandName: string | null;
  questionCount: number;
};

export type ImportReason =
  | "ok"
  | "not_found"
  | "not_anonymous"
  | "host_mismatch"
  | "too_old"
  | "already_imported"
  | "question_limit";

export type FreeScanHandoffDeps = {
  addWorkspaceQuestion?: typeof defaultAddWorkspaceQuestion;
  now?: () => number;
};

export function extractFreeScanQuestions(scan: Record<string, unknown>): string[] {
  const rawResults = (scan.raw_results as Record<string, unknown> | null) ?? {};
  const rawArray = Array.isArray(rawResults.results)
    ? (rawResults.results as unknown[])
    : Array.isArray(scan.raw_results)
      ? (scan.raw_results as unknown[])
      : [];

  const seen = new Set<string>();
  const questions: string[] = [];

  for (const item of rawArray) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    if (r.is_control || r.isControl) continue;
    const isBranded = r.is_branded_query ?? r.isBrandedQuery;
    if (isBranded) continue;
    if (r.source === "branded_seed") continue;
    if (typeof r.query !== "string") continue;

    const canonical = canonicalQuestionText(r.query);
    if (canonical.length < 8 || canonical.length > 300) continue;

    const norm = normalizeQuestionText(canonical);
    if (seen.has(norm)) continue;
    seen.add(norm);

    questions.push(canonical);
    if (questions.length >= 30) break;
  }

  return questions;
}

export async function readFreeScanPrefill(
  admin: SupabaseClient,
  scanId?: string | null,
  domain?: string | null,
  deps?: { now?: () => number },
): Promise<Prefill | null> {
  const normScanId = normalizeScanId(scanId);
  const normDomain = normalizeHandoffDomain(domain);

  if (normScanId) {
    const { data: scan } = await admin
      .from("scans")
      .select("id, brand, url, brand_key, raw_results, created_at, scanned_at")
      .eq("id", normScanId)
      .maybeSingle();

    if (scan && scan.brand_key == null) {
      const scanDate = new Date(scan.created_at || scan.scanned_at).getTime();
      const now = deps?.now ? deps.now() : Date.now();
      const isWithin30Days = now - scanDate <= 30 * 24 * 60 * 60 * 1000;

      const scanHost = normalizeHandoffDomain(scan.url);
      const matchesDomain = !normDomain || scanHost === normDomain;

      if (isWithin30Days && matchesDomain) {
        const questions = extractFreeScanQuestions(scan as Record<string, unknown>);
        const brand = typeof scan.brand === "string" && scan.brand !== "%" && scan.brand.trim()
          ? scan.brand.trim()
          : null;
        const website = scan.url?.startsWith("http")
          ? scan.url
          : scanHost
            ? `https://${scanHost}`
            : "";

        return {
          website,
          brandName: brand,
          questionCount: questions.length,
        };
      }
    }
  }

  if (normDomain) {
    return {
      website: `https://${normDomain}`,
      brandName: null,
      questionCount: 0,
    };
  }

  return null;
}

export async function importFreeScanQuestions(
  admin: SupabaseClient,
  ws: { brandKey?: string; brand?: { brand_key?: string; website_host?: string; websiteHost?: string } },
  scanId: string | null | undefined,
  userId: string,
  deps?: FreeScanHandoffDeps,
): Promise<{ imported: number; reason: ImportReason }> {
  const normScanId = normalizeScanId(scanId);
  if (!normScanId) {
    return { imported: 0, reason: "not_found" };
  }

  const { data: scan } = await admin
    .from("scans")
    .select("id, brand, url, brand_key, raw_results, created_at, scanned_at")
    .eq("id", normScanId)
    .maybeSingle();

  if (!scan) {
    return { imported: 0, reason: "not_found" };
  }

  if (scan.brand_key != null) {
    return { imported: 0, reason: "not_anonymous" };
  }

  const scanDate = new Date(scan.created_at || scan.scanned_at).getTime();
  const now = deps?.now ? deps.now() : Date.now();
  if (now - scanDate > 30 * 24 * 60 * 60 * 1000) {
    return { imported: 0, reason: "too_old" };
  }

  const scanHost = normalizeHandoffDomain(scan.url);
  const wsHost = ws.brand?.website_host ?? ws.brand?.websiteHost ?? "";
  if (!scanHost || normalizeHandoffDomain(wsHost) !== scanHost) {
    return { imported: 0, reason: "host_mismatch" };
  }

  const brandKey = ws.brandKey ?? ws.brand?.brand_key ?? "";
  const questions = extractFreeScanQuestions(scan as Record<string, unknown>);
  const addFn = deps?.addWorkspaceQuestion ?? defaultAddWorkspaceQuestion;

  let imported = 0;
  for (const text of questions) {
    try {
      await addFn(admin, {
        brandKey,
        text,
        origin: "promptgen",
        createdBy: userId,
        status: "paused",
        topic: "From your free scan",
        sourceRef: { kind: "free_scan", id: normScanId },
      });
      imported++;
    } catch (err: unknown) {
      if (
        (err as { code?: string })?.code === "question_limit" ||
        (err instanceof AppError && err.code === "question_limit")
      ) {
        return { imported, reason: "question_limit" };
      }
      throw err;
    }
  }

  return { imported, reason: "ok" };
}
