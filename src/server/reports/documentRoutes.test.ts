// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/reportRoute.test.ts
//   src/server/features/reports/shareRawRoute.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// F23-AC-07, 09, 11, 12 (§6.2.5): the private document and the shared raw
// document. Every dependency is injected — no database, no session, no
// network — so a scanner walking /s/<anything> costs nothing even here.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleReportRequest,
  handleSharedReportRequest,
  NOT_FOUND_BODY,
  NOT_SHARED_BODY,
  type DocDeps,
  type ReportCustomerContext,
} from "./documentRoutes.ts";
import { PRINT_SCRIPT, REPORT_CSP, reportCsp } from "../../shared/report-sandbox.ts";
import { SHARE_TOKEN_PATTERN, sharePseudonym } from "../../shared/report-share.ts";
import type { SharedReportRow } from "./sharePage.ts";
import { setReportEventTracker } from "./telemetry.ts";

const HTML = "<!doctype html>\n<html><body><p>Report</p></body></html>";
const REPORT_ID = "11111111-1111-1111-8111-111111111111";
const BRAND = "brand-a";
const TOKEN = "a".repeat(32);

const SHARED_ROW: SharedReportRow = {
  id: REPORT_ID,
  brand_key: BRAND,
  title: "Acme Tees AI visibility audit",
  summary: "One clear verdict.",
  skill: "seo-audit",
  updated_at: "2026-11-17T12:00:00.000Z",
  website_host: "acme.example",
  workspace_active: true,
  sanitizer_version: 1,
};

type FakeOptions = {
  meta?: { brand_key: string; sanitizer_version: number } | null;
  html?: string | null;
  shared?: SharedReportRow | null;
};

type Call = { kind: string; detail?: unknown };

function fakeAdmin(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const meta = opts.meta === undefined ? { brand_key: BRAND, sanitizer_version: 1 } : opts.meta;
  const html = opts.html === undefined ? HTML : opts.html;
  const shared = opts.shared === undefined ? { ...SHARED_ROW } : opts.shared;

  const query = () => {
    const state = { selected: "", filters: [] as Array<[string, unknown]>, patch: null as unknown };
    const self = {
      select(cols: string) {
        state.selected = cols;
        return self;
      },
      eq(col: string, value: unknown) {
        state.filters.push([col, value]);
        return self;
      },
      update(patch: unknown) {
        state.patch = patch;
        return self;
      },
      // Supabase builders are thenable: awaiting one executes it. The fake
      // mirrors that so the implementation can await an update bare, the way
      // repository.ts does.
      then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        return self.maybeSingle().then(onFulfilled, onRejected);
      },
      async maybeSingle() {
        if (state.patch !== null) {
          calls.push({ kind: "update", detail: { patch: state.patch, filters: state.filters } });
          return { data: null, error: null };
        }
        if (state.selected.includes("html")) {
          calls.push({ kind: "read-html", detail: state.filters });
          return { data: html === null ? null : { html }, error: null };
        }
        calls.push({ kind: "read-meta", detail: state.filters });
        return { data: meta, error: null };
      },
    };
    return self;
  };

  const admin = {
    from(_table: string) {
      return query();
    },
    rpc: async (fn: string, args: unknown) => {
      calls.push({ kind: `rpc:${fn}`, detail: args });
      if (fn === "get_shared_report") return { data: shared ? [shared] : [], error: null };
      if (fn === "record_report_view") return { data: null, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

function contextFor(
  brands: Array<{ brandKey: string }> = [{ brandKey: BRAND }],
  user: { id: string } | null = { id: "user-1" },
  error: string | null = null
): () => Promise<ReportCustomerContext> {
  return async () => ({ client: null, user, brands, error });
}

function harness(opts: FakeOptions = {}, deps: Partial<DocDeps> = {}) {
  const { admin, calls } = fakeAdmin(opts);
  const kept: unknown[] = [];
  const full: DocDeps = {
    getCustomerContext: contextFor(),
    getSupabaseAdmin: () => admin,
    isFeatureEnabled: async () => true,
    keepAlive: (work) => {
      kept.push(work());
      return undefined;
    },
    ...deps,
  };
  return { admin, calls, kept, deps: full };
}

const privateRequest = (id = REPORT_ID, query = "") =>
  new Request(`https://app.example.com/r/${id}${query}`);

const framed = (token = TOKEN) =>
  new Request(`https://app.example.com/s/${token}/raw`, { headers: { "Sec-Fetch-Dest": "iframe" } });

beforeEach(() => setReportEventTracker(null));

// ---------------------------------------------------------------------------
// handleReportRequest
// ---------------------------------------------------------------------------

test("serves the stored document with the exact sandbox headers", async () => {
  const { deps, calls } = harness();

  const response = await handleReportRequest(REPORT_ID, privateRequest(), deps);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), HTML);
  assert.deepEqual(Object.fromEntries(response.headers), {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": REPORT_CSP,
    "cross-origin-opener-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "cache-control": "private, no-store",
  });
  // Authorized against the row's brand before the document is read.
  const metaReads = calls.filter((call) => call.kind === "read-meta");
  const htmlReads = calls.filter((call) => call.kind === "read-html");
  assert.equal(metaReads.length, 1);
  assert.equal(htmlReads.length, 1);
  assert.deepEqual(htmlReads[0]?.detail, [
    ["id", REPORT_ID],
    ["brand_key", BRAND],
  ]);
});

test("appends the print script and widens the sandbox in print mode", async () => {
  const { deps } = harness();

  const response = await handleReportRequest(REPORT_ID, privateRequest(REPORT_ID, "?print=1"), deps);

  assert.equal(
    await response.text(),
    `<!doctype html>\n<html><body><p>Report</p><script>${PRINT_SCRIPT}</script></body></html>`
  );
  assert.equal(response.headers.get("content-security-policy"), reportCsp(true));
});

test("gives a dangling script tag in the document no attribute to absorb", async () => {
  const { deps } = harness({
    html: '<!doctype html><html><body><script src="https://evil.example/x.js" </body></html>',
  });

  const response = await handleReportRequest(REPORT_ID, privateRequest(REPORT_ID, "?print=1"), deps);

  const body = await response.text();
  assert.equal(
    body,
    '<!doctype html><html><body><script src="https://evil.example/x.js" ' +
      `<script>${PRINT_SCRIPT}</script></body></html>`
  );
  assert.ok(!response.headers.get("content-security-policy")?.includes("'nonce-"));
});

test("answers 404 without a query for a malformed id", async () => {
  let adminCalls = 0;
  const { deps } = harness({}, { getSupabaseAdmin: () => ((adminCalls += 1), null) });

  const response = await handleReportRequest("not-a-uuid", privateRequest("not-a-uuid"), deps);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), NOT_FOUND_BODY);
  assert.equal(adminCalls, 0);
});

test("answers the same 404 for an unknown report and a foreign workspace", async () => {
  const unknown = harness({ meta: null });
  const unknownResponse = await handleReportRequest(REPORT_ID, privateRequest(), unknown.deps);
  assert.equal(unknownResponse.status, 404);
  assert.equal(await unknownResponse.text(), NOT_FOUND_BODY);
  assert.ok(!unknown.calls.some((call) => call.kind === "read-html"));

  const foreign = harness({ meta: { brand_key: "brand-b", sanitizer_version: 1 } });
  const foreignResponse = await handleReportRequest(REPORT_ID, privateRequest(), foreign.deps);
  assert.equal(foreignResponse.status, 404);
  assert.equal(await foreignResponse.text(), NOT_FOUND_BODY);
  assert.ok(!foreign.calls.some((call) => call.kind === "read-html"));
});

test("answers 404 when the reports flag is off", async () => {
  const { deps } = harness({}, { isFeatureEnabled: async () => false });

  const response = await handleReportRequest(REPORT_ID, privateRequest(), deps);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), NOT_FOUND_BODY);
});

test("bounces a signed-out reader to sign-in with the report in next", async () => {
  const { deps } = harness({}, { getCustomerContext: contextFor([], null) });

  const response = await handleReportRequest(REPORT_ID, privateRequest(), deps);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `/login?next=${encodeURIComponent(`/r/${REPORT_ID}`)}`);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("answers 503 when sign-in is not configured", async () => {
  const { deps } = harness({}, { getCustomerContext: contextFor([], null, "auth_not_configured") });

  const response = await handleReportRequest(REPORT_ID, privateRequest(), deps);

  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Sign-in is not configured.");
});

test("answers 503 when workspace access cannot be checked", async () => {
  const { deps } = harness({}, { getCustomerContext: contextFor([], { id: "user-1" }, "membership_unavailable") });

  const response = await handleReportRequest(REPORT_ID, privateRequest(), deps);

  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Could not check your access. Please retry.");
});

test("re-sanitises a document written by an older sanitiser before serving", async () => {
  const hostile = `<!doctype html><html><body><script>alert(1)</script><p>Body</p></body></html>`;
  const { deps, calls, kept } = harness({
    meta: { brand_key: BRAND, sanitizer_version: 0 },
    html: hostile,
  });

  const response = await handleReportRequest(REPORT_ID, privateRequest(), deps);
  await Promise.all(kept);

  const body = await response.text();
  assert.ok(!body.includes("<script>alert"), "the served document is re-sanitised");
  assert.ok(body.includes("<p>Body</p>"));
  const updates = calls.filter((call) => call.kind === "update");
  assert.equal(updates.length, 1);
  const patch = (updates[0]?.detail as { patch: Record<string, unknown> }).patch;
  assert.equal(patch.sanitizer_version, 1);
  assert.equal(patch.html, body);
  // The write-back is conditional on the version that was read, so a save that
  // landed in between is not overwritten by a re-sanitised older copy.
  const filters = (updates[0]?.detail as { filters: Array<[string, unknown]> }).filters;
  assert.deepEqual(
    filters,
    [
      ["id", REPORT_ID],
      ["brand_key", BRAND],
      ["sanitizer_version", 0],
    ],
  );
});

// ---------------------------------------------------------------------------
// handleSharedReportRequest
// ---------------------------------------------------------------------------

test("serves the shared document to the frame with the exact headers", async () => {
  const { deps } = harness();

  const response = await handleSharedReportRequest(TOKEN, framed(), deps);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), HTML);
  assert.deepEqual(Object.fromEntries(response.headers), {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": REPORT_CSP,
    "cross-origin-opener-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "cache-control": "public, max-age=0, s-maxage=60",
  });
});

test("bounces a top-level request to the wrapped page without reading html", async () => {
  const { deps, calls } = harness();

  const response = await handleSharedReportRequest(
    TOKEN,
    new Request(`https://app.example.com/s/${TOKEN}/raw`, { headers: { "Sec-Fetch-Dest": "document" } }),
    deps
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `/s/${TOKEN}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(!calls.some((call) => call.kind === "read-html"));
});

test("bounces a query string to the bare path before any query", async () => {
  const { deps, calls } = harness();

  const response = await handleSharedReportRequest(
    TOKEN,
    new Request(`https://app.example.com/s/${TOKEN}/raw?x=1`, { headers: { "Sec-Fetch-Dest": "iframe" } }),
    deps
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `/s/${TOKEN}/raw`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(!calls.some((call) => call.kind.startsWith("rpc:")));
});

test("serves the document when the request carries no Sec-Fetch-Dest", async () => {
  const { deps } = harness();

  const response = await handleSharedReportRequest(TOKEN, new Request(`https://app.example.com/s/${TOKEN}/raw`), deps);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), HTML);
});

test("answers 404 without a query for a malformed token", async () => {
  const { deps, calls } = harness();

  const response = await handleSharedReportRequest("nope", framed("nope"), deps);

  assert.equal(response.status, 404);
  assert.equal(await response.text(), NOT_SHARED_BODY);
  assert.ok(!calls.some((call) => call.kind.startsWith("rpc:")));
});

test("answers the same 404 for unknown, inactive and flag-off links", async () => {
  assert.ok(SHARE_TOKEN_PATTERN.test(TOKEN));

  const unknown = harness({ shared: null });
  const unknownResponse = await handleSharedReportRequest(TOKEN, framed(), unknown.deps);
  assert.equal(unknownResponse.status, 404);
  assert.equal(await unknownResponse.text(), NOT_SHARED_BODY);
  assert.ok(!unknown.calls.some((call) => call.kind === "read-html"));

  const inactive = harness({ shared: { ...SHARED_ROW, workspace_active: false } });
  const inactiveResponse = await handleSharedReportRequest(TOKEN, framed(), inactive.deps);
  assert.equal(inactiveResponse.status, 404);
  assert.equal(await inactiveResponse.text(), NOT_SHARED_BODY);
  assert.ok(!inactive.calls.some((call) => call.kind === "read-html"));

  const flagOff = harness({}, { isFeatureEnabled: async () => false });
  const flagOffResponse = await handleSharedReportRequest(TOKEN, framed(), flagOff.deps);
  assert.equal(flagOffResponse.status, 404);
  assert.equal(await flagOffResponse.text(), NOT_SHARED_BODY);
  assert.ok(!flagOff.calls.some((call) => call.kind === "read-html"));
});

test("records one anonymous view with the pseudonym, never the token", async () => {
  const events: Array<{ name: string; props: Record<string, unknown> }> = [];
  setReportEventTracker((name, props) => {
    events.push({ name, props });
  });
  const { deps, calls, kept } = harness();

  const response = await handleSharedReportRequest(TOKEN, framed(), deps);
  await Promise.all(kept);

  assert.equal(response.status, 200);
  const expectedPseudonym = await sharePseudonym(TOKEN);
  assert.match(expectedPseudonym, /^share:[0-9a-f]{16}$/);
  assert.ok(!expectedPseudonym.includes(TOKEN));
  assert.notEqual(expectedPseudonym, TOKEN);
  const views = calls.filter((call) => call.kind === "rpc:record_report_view");
  assert.equal(views.length, 1);
  assert.deepEqual(views[0]?.detail, {
    p_report: REPORT_ID,
    p_brand: BRAND,
    p_pseudonym: expectedPseudonym,
    p_from_browser: true,
  });
  assert.deepEqual(events, [{ name: "report:public_view", props: { from_browser: true } }]);
});

test("marks a non-framed fetch as not from a browser", async () => {
  setReportEventTracker(() => {});
  const { deps, calls, kept } = harness();

  await handleSharedReportRequest(TOKEN, new Request(`https://app.example.com/s/${TOKEN}/raw`), deps);
  await Promise.all(kept);

  const views = calls.filter((call) => call.kind === "rpc:record_report_view");
  assert.equal(views.length, 1);
  assert.deepEqual(views[0]?.detail, {
    p_report: REPORT_ID,
    p_brand: BRAND,
    p_pseudonym: await sharePseudonym(TOKEN),
    p_from_browser: false,
  });
});

test("re-sanitises a shared document written by an older sanitiser", async () => {
  const hostile = `<!doctype html><html><body><script>alert(1)</script><p>Body</p></body></html>`;
  const { deps, calls, kept } = harness({
    shared: { ...SHARED_ROW, sanitizer_version: 0 },
    html: hostile,
  });

  const response = await handleSharedReportRequest(TOKEN, framed(), deps);
  await Promise.all(kept);

  const body = await response.text();
  assert.ok(!body.includes("<script>alert"));
  const updates = calls.filter((call) => call.kind === "update");
  assert.equal(updates.length, 1);
});

test("a view-record failure is logged, never thrown into the reader", async () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const { admin } = fakeAdmin();
    const failing = {
      ...admin,
      rpc: async (fn: string, args: unknown) => {
        if (fn === "record_report_view") return { data: null, error: { message: "db down" } };
        return (admin.rpc as unknown as (fn: string, args: unknown) => Promise<unknown>)(fn, args);
      },
    } as unknown as SupabaseClient;
    const kept: unknown[] = [];
    const deps: DocDeps = {
      getCustomerContext: contextFor(),
      getSupabaseAdmin: () => failing,
      isFeatureEnabled: async () => true,
      keepAlive: (work) => {
        kept.push(work());
        return undefined;
      },
    };

    const response = await handleSharedReportRequest(TOKEN, framed(), deps);
    await Promise.all(kept);

    assert.equal(response.status, 200);
    assert.deepEqual(errors, [[`[reports] view record failed ${REPORT_ID}`]]);
  } finally {
    console.error = original;
  }
});
