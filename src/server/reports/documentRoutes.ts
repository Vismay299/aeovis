// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/r/$reportId.ts
//   src/routes/s/$token/raw.ts
//   src/routes/s/$token/og[.]png.ts
//   src/server/features/reports/shareAccess.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// Pure handlers for the document routes (§6.2.5). The App Router route files
// call them; they never touch the network themselves beyond the injected
// seams, so every case below runs hermetically in a unit test.
//
// Authorization order is deliberate: the HTML column is read only after the
// caller is authorized, so an unauthorized request never pulls a document
// onto the worker's heap.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";
import { findCustomerBrand } from "../../shared/supabase/customerContext.js";
import { SHARE_TOKEN_PATTERN, sharePseudonym } from "../../shared/report-share.ts";
import {
  FIXTURE_REPORT_HOST,
  FIXTURE_REPORT_TITLE,
  fixtureDocumentPathForReport,
  fixtureDocumentPathForToken,
  isFixtureMode,
  readFixtureDocument,
} from "./fixtureMode.ts";
import { reportDocumentResponse, textResponse } from "../../shared/report-sandbox.ts";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { keepAlive as keepAliveDefault } from "../keepAlive.js";
import { SANITIZER_VERSION, sanitizeReportHtml } from "./sanitize.ts";
import { captureReportEvent } from "./telemetry.ts";
import type { SharedReportRow } from "./sharePage.ts";

export { handleSharePage } from "./sharePage.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One body for "no such report" and "another workspace's report". */
export const NOT_FOUND_BODY = "This report does not exist or you do not have access to it.";

/** One body for every public dead end: unknown, revoked, inactive or flag off. */
export const NOT_SHARED_BODY = "This report isn't shared.";

export type ReportCustomerContext = {
  user: { id: string; email?: string | null } | null;
  brands: Array<{ brandKey: string }>;
  error: string | null;
  cause?: unknown;
};

/**
 * The seams a test may replace. Production callers pass nothing: the admin
 * client, the feature flags and the session all resolve from the environment.
 */
export type DocDeps = {
  getCustomerContext?: () => Promise<ReportCustomerContext>;
  getSupabaseAdmin?: () => SupabaseClient | null;
  isFeatureEnabled?: (name: FeatureName, brandKey?: string) => Promise<boolean>;
  keepAlive?: (work: () => Promise<unknown>, opts?: { label?: string }) => unknown;
  now?: () => Date;
};

export type SocialImageRenderer = (title: string, host: string | null) => Promise<Response>;

async function defaultGetCustomerContext(): Promise<ReportCustomerContext> {
  // Dynamic so importing this module never pulls next/headers into a unit
  // test; the route runtime resolves it on the first real request.
  const { getCustomerContext } = await import("../../shared/supabase/customer.js");
  return getCustomerContext() as Promise<ReportCustomerContext>;
}

function resolveAdmin(deps?: DocDeps): SupabaseClient {
  const load = deps?.getSupabaseAdmin ?? getSupabaseAdmin;
  const admin = load();
  if (!admin) throw new Error("[reports] storage is not configured");
  return admin;
}

type ReportMetaRow = { brand_key: string; sanitizer_version: number };

async function selectReportMeta(admin: SupabaseClient, reportId: string): Promise<ReportMetaRow | null> {
  const { data, error } = await admin
    .from("reports")
    .select("brand_key,sanitizer_version")
    .eq("id", reportId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as ReportMetaRow | null;
}

async function selectSharedReport(admin: SupabaseClient, token: string): Promise<SharedReportRow | null> {
  const { data, error } = await admin.rpc("get_shared_report", { p_token: token });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as SharedReportRow | null | undefined;
  return row ?? null;
}

async function selectReportHtml(
  admin: SupabaseClient,
  reportId: string,
  brandKey: string
): Promise<string | null> {
  const { data, error } = await admin
    .from("reports")
    .select("html")
    .eq("id", reportId)
    .eq("brand_key", brandKey)
    .maybeSingle();
  if (error) throw error;
  const html = (data as { html?: unknown } | null)?.html;
  return typeof html === "string" ? html : null;
}

/**
 * Serves a stored document, re-sanitising rows written by an older sanitiser
 * (§6.2.2). The write-back runs in keepAlive so a slow update never holds the
 * response; a failed write is logged, never thrown into the reader.
 */
async function serveStoredHtml(
  admin: SupabaseClient,
  input: { reportId: string; brandKey: string; html: string; version: number },
  deps?: DocDeps
): Promise<string> {
  if (input.version >= SANITIZER_VERSION) return input.html;
  const sanitized = sanitizeReportHtml(input.html);
  const html = sanitized.html;
  const keep = deps?.keepAlive ?? keepAliveDefault;
  keep(
    async () => {
      try {
        const { error } = await admin
          .from("reports")
          .update({
            html,
            size_bytes: new TextEncoder().encode(html).length,
            sanitizer_version: SANITIZER_VERSION,
          })
          .eq("id", input.reportId)
          .eq("brand_key", input.brandKey)
          // Compare-and-set on the version that was read: a save that landed
          // between that read and this write carries the current version and
          // must not be overwritten by a re-sanitised copy of its predecessor.
          .eq("sanitizer_version", input.version);
        if (error) throw error;
      } catch {
        console.error(`[reports] resanitize failed ${input.reportId}`);
      }
    },
    { label: "report resanitize" }
  );
  return html;
}

/**
 * `GET /r/[reportId]` (§6.2.5). Auth by session; one 404 body for every dead
 * end; `private, no-store`; print mode appends the hash-locked script.
 */
export async function handleReportRequest(
  reportId: string,
  request: Request,
  deps: DocDeps = {}
): Promise<Response> {
  const notFound = () => textResponse(NOT_FOUND_BODY, 404);
  if (isFixtureMode()) {
    const fixturePath = fixtureDocumentPathForReport(reportId);
    if (!fixturePath) return notFound();
    const html = await readFixtureDocument(fixturePath);
    if (html === null) return notFound();
    const print = new URL(request.url).searchParams.get("print") === "1";
    return reportDocumentResponse(html, { print, cacheControl: "private, no-store", noindex: true });
  }
  if (!UUID_PATTERN.test(reportId)) return notFound();

  const loadContext = deps.getCustomerContext ?? defaultGetCustomerContext;
  const context = await loadContext();
  if (context.error === "auth_not_configured") {
    return textResponse("Sign-in is not configured.", 503);
  }
  if (!context.user) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/login?next=${encodeURIComponent(`/r/${reportId}`)}`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  if (context.error) {
    return textResponse("Could not check your access. Please retry.", 503);
  }

  const admin = resolveAdmin(deps);
  const meta = await selectReportMeta(admin, reportId);
  if (!meta) return notFound();
  if (!findCustomerBrand(context.brands, meta.brand_key)) return notFound();

  const flag = deps.isFeatureEnabled ?? isFeatureEnabledDefault;
  if (!(await flag("reports", meta.brand_key))) return notFound();

  const stored = await selectReportHtml(admin, reportId, meta.brand_key);
  if (stored === null) return notFound();

  const html = await serveStoredHtml(
    admin,
    { reportId, brandKey: meta.brand_key, html: stored, version: meta.sanitizer_version },
    deps
  );
  const print = new URL(request.url).searchParams.get("print") === "1";
  return reportDocumentResponse(html, { print, cacheControl: "private, no-store", noindex: true });
}

/**
 * `GET /s/[token]/raw` (§6.2.5). Authorized by the unguessable token: shape
 * first (no query), then the query-string bounce, then the token lookup.
 * Records one anonymous view per serve.
 */
export async function handleSharedReportRequest(
  token: string,
  request: Request,
  deps: DocDeps = {}
): Promise<Response> {
  const notShared = () => textResponse(NOT_SHARED_BODY, 404);
  if (!SHARE_TOKEN_PATTERN.test(token)) return notShared();

  // The query string is part of the edge cache key, so a cache-busting query
  // bounces to the bare path before anything is read.
  const url = new URL(request.url);
  if (url.search !== "") {
    return new Response(null, {
      status: 302,
      headers: { Location: `/s/${token}/raw`, "Cache-Control": "no-store" },
    });
  }

  if (isFixtureMode()) {
    const dest = request.headers.get("sec-fetch-dest");
    if (dest !== null && dest !== "iframe") {
      return new Response(null, {
        status: 302,
        headers: { Location: `/s/${token}`, "Cache-Control": "no-store" },
      });
    }
    const fixturePath = fixtureDocumentPathForToken(token);
    if (!fixturePath) return notShared();
    const html = await readFixtureDocument(fixturePath);
    if (html === null) return notShared();
    // No view recording or telemetry in fixture mode: there is no database.
    return reportDocumentResponse(html, { cacheControl: "public, max-age=0, s-maxage=60", noindex: true });
  }

  const admin = resolveAdmin(deps);
  const row = await selectSharedReport(admin, token);
  const flag = deps.isFeatureEnabled ?? isFeatureEnabledDefault;
  if (!row || !row.workspace_active || !(await flag("report_sharing", row.brand_key))) {
    return notShared();
  }

  // The document is only reachable inside the wrapper page's frame. A client
  // that sends no Sec-Fetch-Dest at all (curl, a link-preview fetcher) is
  // served the document: bouncing it would send it to a page whose frame it
  // cannot load either.
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null && dest !== "iframe") {
    return new Response(null, {
      status: 302,
      headers: { Location: `/s/${token}`, "Cache-Control": "no-store" },
    });
  }

  const stored = await selectReportHtml(admin, row.id, row.brand_key);
  if (stored === null) return notShared();

  const html = await serveStoredHtml(
    admin,
    { reportId: row.id, brandKey: row.brand_key, html: stored, version: row.sanitizer_version },
    deps
  );

  const fromBrowser = dest === "iframe";
  const pseudonym = await sharePseudonym(token);
  const keep = deps.keepAlive ?? keepAliveDefault;
  keep(
    async () => {
      try {
        const { error } = await admin.rpc("record_report_view", {
          p_report: row.id,
          p_brand: row.brand_key,
          p_pseudonym: pseudonym,
          p_from_browser: fromBrowser,
        });
        if (error) throw error;
      } catch {
        console.error(`[reports] view record failed ${row.id}`);
      }
    },
    { label: "report view record" }
  );
  captureReportEvent("report:public_view", { from_browser: fromBrowser });

  return reportDocumentResponse(html, { cacheControl: "public, max-age=0, s-maxage=60", noindex: true });
}

/**
 * `GET /s/[token]/og.png` (§6.2.5, §6.2.7). The same access checks as the raw
 * document, then the injected renderer. A lookup failure propagates — it must
 * not hide behind the image fallback — while a render failure answers 500.
 */
/** Fixture-only 500: mirrors the production fallback without touching its code path. */
function fixtureSocialImageUnavailable(): Response {
  console.error("[reports] social image failed");
  return new Response("Preview image unavailable.", {
    status: 500,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export async function handleReportSocialImage(
  token: string,
  deps: DocDeps & { render?: SocialImageRenderer } = {}
): Promise<Response> {
  if (!SHARE_TOKEN_PATTERN.test(token)) return textResponse(NOT_SHARED_BODY, 404);

  if (isFixtureMode()) {
    if (!fixtureDocumentPathForToken(token)) return textResponse(NOT_SHARED_BODY, 404);
    try {
      if (!deps.render) throw new Error("[reports] no social image renderer");
      return await deps.render(FIXTURE_REPORT_TITLE, FIXTURE_REPORT_HOST);
    } catch {
      return fixtureSocialImageUnavailable();
    }
  }

  const admin = resolveAdmin(deps);
  const row = await selectSharedReport(admin, token);
  const flag = deps.isFeatureEnabled ?? isFeatureEnabledDefault;
  if (!row || !row.workspace_active || !(await flag("report_sharing", row.brand_key))) {
    return textResponse(NOT_SHARED_BODY, 404);
  }

  try {
    if (!deps.render) throw new Error("[reports] no social image renderer");
    return await deps.render(row.title, row.website_host ?? null);
  } catch {
    console.error("[reports] social image failed");
    return new Response("Preview image unavailable.", {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }
}
