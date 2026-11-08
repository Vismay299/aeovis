// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/indexnow/services/IndexNowService.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/errors.ts";
import { pluralUrls, type SubmissionSource } from "../../shared/indexnow.ts";
import { indexNowDomain, ensureKey } from "./keys.ts";
import { checkKeyFile, keyFileProblem } from "./keyFile.ts";
import { assertSubmitAllowed, readIndexNowLimits, type IndexNowLimits } from "./limits.ts";

export const INDEXNOW_ENDPOINTS = [
  { engine: "bing", url: "https://www.bing.com/indexnow" },
  { engine: "yandex", url: "https://yandex.com/indexnow" },
  { engine: "yep", url: "https://indexnow.yep.com/indexnow" },
] as const;

export const SUBMIT_TIMEOUT_MS = 10_000;

export type HostResult = {
  host: string;
  urlCount: number;
  status: "submitted" | "failed";
  engine: "bing" | "yandex" | "yep" | null;
  httpStatus: number | null;
  reason: string | null;
  message: string;
};

export type SkippedUrl = {
  url: string;
  reason: "off_site" | "invalid" | "recently_submitted";
};

export function groupUrlsByHost(
  domain: string,
  urls: string[]
): { byHost: Map<string, string[]>; skipped: SkippedUrl[] } {
  const byHost = new Map<string, string[]>();
  const skipped: SkippedUrl[] = [];

  for (const raw of urls) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) {
      skipped.push({ url: raw, reason: "invalid" });
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      skipped.push({ url: raw, reason: "invalid" });
      continue;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      skipped.push({ url: raw, reason: "invalid" });
      continue;
    }

    const host = parsed.hostname.toLowerCase();
    if (host !== domain && !host.endsWith("." + domain)) {
      skipped.push({ url: raw, reason: "off_site" });
      continue;
    }

    parsed.hash = "";
    const cleanUrl = parsed.toString();

    const existing = byHost.get(host) ?? [];
    if (!existing.includes(cleanUrl)) {
      existing.push(cleanUrl);
      byHost.set(host, existing);
    }
  }

  return { byHost, skipped };
}

export function describeResponse(
  status: number,
  urlCount: number,
  host: string
): { status: "submitted" | "failed"; reason: string | null; message: string } {
  const nUrls = pluralUrls(urlCount);
  switch (status) {
    case 200:
      return { status: "submitted", reason: null, message: `Submitted ${nUrls}.` };
    case 202:
      return {
        status: "submitted",
        reason: null,
        message: `Submitted ${nUrls}. Search engines will verify the key file on https://${host} first.`,
      };
    case 400:
      return {
        status: "failed",
        reason: "bad_request",
        message: "IndexNow rejected the request. Check that the URLs are complete addresses.",
      };
    case 403:
      return {
        status: "failed",
        reason: "key_rejected",
        message: `The key wasn't accepted. Check that the key file on https://${host} contains only the key.`,
      };
    case 422:
      return {
        status: "failed",
        reason: "urls_rejected",
        message: `IndexNow rejected these URLs. Check that they belong to https://${host}.`,
      };
    case 429:
      return {
        status: "failed",
        reason: "rate_limited",
        message:
          "Search engines are refusing submissions right now. Try again later, and only submit pages that changed.",
      };
    default:
      return {
        status: "failed",
        reason: "http_error",
        message: `IndexNow returned HTTP ${status}.`,
      };
  }
}

export async function postToEngine(
  endpoint: { engine: "bing" | "yandex" | "yep"; url: string },
  body: string,
  deps?: { fetchImpl?: typeof fetch }
): Promise<number | undefined> {
  const fetcher = deps?.fetchImpl ?? fetch;
  try {
    const res = await fetcher(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => {});
    console.log(`[indexnow] engine ${endpoint.engine} status ${res.status}`);
    return res.status;
  } catch {
    console.log(`[indexnow] engine ${endpoint.engine} status none`);
    return undefined;
  }
}

export async function submitHost(
  host: string,
  key: string,
  urls: string[],
  deps?: { safeFetch?: any; fetchImpl?: typeof fetch }
): Promise<HostResult> {
  const checkStatus = await checkKeyFile(host, key, deps);
  const problem = keyFileProblem(host, checkStatus);

  if (problem) {
    return {
      host,
      urlCount: urls.length,
      status: "failed",
      engine: null,
      httpStatus: null,
      reason: checkStatus,
      message: problem,
    };
  }

  const body = JSON.stringify({ host, key, urlList: urls });
  let status: number | undefined;
  let lastEngine: "bing" | "yandex" | "yep" | null = null;

  for (const ep of INDEXNOW_ENDPOINTS) {
    lastEngine = ep.engine;
    status = await postToEngine(ep, body, deps);
    if (status !== undefined && status !== 429 && status < 500) {
      break;
    }
  }

  if (status === undefined) {
    return {
      host,
      urlCount: urls.length,
      status: "failed",
      engine: lastEngine,
      httpStatus: null,
      reason: "no_response",
      message: "IndexNow didn't respond. Try again later.",
    };
  }

  const desc = describeResponse(status, urls.length, host);
  return {
    host,
    urlCount: urls.length,
    status: desc.status,
    engine: lastEngine,
    httpStatus: status,
    reason: desc.reason,
    message: desc.message,
  };
}

export async function submitUrls(
  admin: SupabaseClient,
  ws: { brandKey: string; brand: { website_host: string }; user?: { id?: string } | null },
  i: { urls: string[]; source: SubmissionSource; sourceRef?: string; requestId: string },
  deps?: {
    now?: Date;
    limits?: IndexNowLimits;
    safeFetch?: any;
    fetchImpl?: typeof fetch;
    generateKey?: () => string;
  }
): Promise<{ key: string; keyCreated: boolean; hosts: HostResult[]; skipped: SkippedUrl[] }> {
  if (!i.urls || !Array.isArray(i.urls) || i.urls.length === 0 || i.urls.length > 10_000) {
    throw new AppError(400, "invalid_request", "URLs must contain between 1 and 10,000 items.");
  }

  const domain = indexNowDomain(ws.brand);
  const now = deps?.now ?? new Date();

  // Idempotency: return existing results for requestId
  const { data: existingRows, error: existingErr } = await admin
    .from("indexnow_submissions")
    .select("host, url_count, status, engine, http_status, reason, message")
    .eq("brand_key", ws.brandKey)
    .eq("request_id", i.requestId);

  if (!existingErr && existingRows && existingRows.length > 0) {
    const { data: keyData } = await admin
      .from("indexnow_keys")
      .select("key")
      .eq("brand_key", ws.brandKey)
      .maybeSingle();

    const hosts: HostResult[] = existingRows.map((r) => ({
      host: r.host,
      urlCount: r.url_count,
      status: r.status as "submitted" | "failed",
      engine: r.engine as "bing" | "yandex" | "yep" | null,
      httpStatus: r.http_status,
      reason: r.reason,
      message: r.message,
    }));

    return {
      key: keyData?.key ?? "",
      keyCreated: false,
      hosts,
      skipped: [],
    };
  }

  const { byHost, skipped } = groupUrlsByHost(domain, i.urls);
  const groupedCount = Array.from(byHost.values()).reduce((sum, list) => sum + list.length, 0);

  const limits = deps?.limits ?? readIndexNowLimits();
  await assertSubmitAllowed(admin, ws.brandKey, groupedCount, now, limits);

  const keyResult = await ensureKey(admin, ws, deps);
  const key = keyResult.key;
  const keyCreated = keyResult.created;

  // Filter recently submitted URLs (submitted within last 600s)
  const allGroupedUrls = Array.from(byHost.values()).flat();
  if (allGroupedUrls.length > 0) {
    const cooldownSecs = limits.resubmitCooldownSeconds;
    const since = new Date(now.getTime() - cooldownSecs * 1000).toISOString();
    const { data: recentUrls } = await admin.rpc("indexnow_recently_submitted", {
      p_brand: ws.brandKey,
      p_urls: allGroupedUrls,
      p_since: since,
    });

    const recentSet = new Set(Array.isArray(recentUrls) ? recentUrls : []);
    if (recentSet.size > 0) {
      for (const [host, hostUrls] of byHost.entries()) {
        const remaining: string[] = [];
        for (const u of hostUrls) {
          if (recentSet.has(u)) {
            skipped.push({ url: u, reason: "recently_submitted" });
          } else {
            remaining.push(u);
          }
        }
        if (remaining.length > 0) {
          byHost.set(host, remaining);
        } else {
          byHost.delete(host);
        }
      }
    }
  }

  const hosts: HostResult[] = [];
  const submissionRows: any[] = [];

  for (const [host, hostUrls] of byHost.entries()) {
    const result = await submitHost(host, key, hostUrls, deps);
    hosts.push(result);

    const sortedUrls = [...hostUrls].sort().slice(0, 100);
    submissionRows.push({
      brand_key: ws.brandKey,
      request_id: i.requestId,
      source: i.source,
      source_ref: i.sourceRef ?? null,
      host: result.host,
      url_count: result.urlCount,
      urls: sortedUrls,
      status: result.status,
      engine: result.engine,
      http_status: result.httpStatus,
      reason: result.reason,
      message: result.message,
      created_by: ws.user?.id ?? null,
      created_at: now.toISOString(),
    });
  }

  if (submissionRows.length > 0) {
    const { error: insertErr } = await admin.from("indexnow_submissions").insert(submissionRows);
    if (insertErr) {
      throw new AppError(503, "indexnow_unavailable", "IndexNow could not be reached. Please retry.");
    }
  }

  const submittedCount = hosts.filter((h) => h.status === "submitted").length;
  const firstEngine = hosts[0]?.engine ?? "none";
  console.log(
    `[indexnow] submit brand=${ws.brandKey} hosts=${hosts.length} submitted=${submittedCount} engine=${firstEngine}`
  );

  return {
    key,
    keyCreated,
    hosts,
    skipped,
  };
}
