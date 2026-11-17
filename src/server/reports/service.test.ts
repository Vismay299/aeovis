// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/services/ReportService.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import { sharePseudonym } from "../../shared/report-share.ts";
import {
  REPORT_MAX_BYTES_PER_WORKSPACE,
  REPORT_MAX_HTML_BYTES,
  REPORT_MAX_INPUT_BYTES,
  REPORT_MAX_PER_WORKSPACE,
  type ReportMetadata,
} from "../../shared/reports.ts";
import { createMemoryStores, type MemoryReportStore } from "./memoryStore.ts";
import {
  deleteReport,
  getReport,
  getReportWithHtml,
  listReports,
  saveReport,
  shareReport,
  unshareReport,
  viewsLast30Days,
  type ReportServiceDeps,
} from "./service.ts";
import { setReportEventTracker } from "./telemetry.ts";

// F23-AC-01…05 (unit halves), plus the sharing and view-count rules of
// §6.2.3. Every case runs against the in-memory store, which mirrors migration
// 150's checks and triggers; the database group proves the SQL itself.

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const BRAND = "brand-a";
const OTHER_BRAND = "brand-b";

const HTML = "<!doctype html>\n<html><body><p>Report</p></body></html>";

const admin = {} as SupabaseClient;

function harness(overrides: Partial<ReportServiceDeps> = {}) {
  const clock = { now: NOW };
  const { reports, templates } = createMemoryStores({ now: () => new Date(clock.now) });
  const deps: ReportServiceDeps = {
    store: reports,
    templates,
    isFeatureEnabled: async () => true,
    now: () => new Date(clock.now),
    ...overrides,
  };
  return { reports, templates, deps, clock };
}

function save(
  deps: ReportServiceDeps,
  overrides: Partial<Parameters<typeof saveReport>[1]> = {}
): Promise<Awaited<ReturnType<typeof saveReport>>> {
  return saveReport(
    admin,
    {
      brandKey: BRAND,
      title: "Acme Tees AI visibility audit — November 17, 2026",
      summary: "One clear verdict.",
      html: HTML,
      createdBy: "assistant",
      createdByUserId: "user-1",
      ...overrides,
    },
    deps
  );
}

async function refusal(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message: string
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
}

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

/** Insert a row straight into the store, the way another save would have. */
async function seed(
  reports: MemoryReportStore,
  overrides: {
    brandKey?: string;
    title?: string;
    html?: string;
    skill?: string | null;
    skillVersion?: string | null;
    templateId?: string | null;
    sizeBytes?: number;
    createdBy?: "assistant" | "app";
    createdByUserId?: string;
  } = {}
): Promise<ReportMetadata> {
  const html = overrides.html ?? HTML;
  const id = randomUUID();
  await reports.insertReport({
    id,
    brandKey: overrides.brandKey ?? BRAND,
    title: overrides.title ?? `Seeded ${id}`,
    summary: "Seeded summary.",
    html,
    skill: overrides.skill ?? null,
    skillVersion: overrides.skillVersion ?? null,
    templateId: overrides.templateId ?? null,
    sessionId: null,
    createdBy: overrides.createdBy ?? "assistant",
    createdByUserId: overrides.createdByUserId ?? "user-1",
    sizeBytes: overrides.sizeBytes ?? byteLength(html),
    sanitizerVersion: 1,
  });
  const report = await reports.getReport(overrides.brandKey ?? BRAND, id);
  assert.ok(report);
  return report;
}

beforeEach(() => setReportEventTracker(null));

// ---------------------------------------------------------------------------
// saveReport
// ---------------------------------------------------------------------------

test("creates a report and returns its sanitised size", async () => {
  const { reports, deps } = harness();
  const result = await save(deps);

  assert.equal(result.created, true);
  assert.equal(result.title, "Acme Tees AI visibility audit — November 17, 2026");
  assert.match(result.reportId, /^[0-9a-f-]{36}$/);
  assert.equal(result.htmlBytes, byteLength(HTML));
  assert.deepEqual(result.sanitized, { changed: false, removedTags: [] });

  const stored = await reports.getReportWithHtml(BRAND, result.reportId);
  assert.ok(stored);
  assert.equal(stored.html, HTML);
  assert.equal(stored.createdBy, "assistant");
  assert.equal(stored.createdByUserId, "user-1");
  assert.equal(stored.sanitizerVersion, 1);
  assert.equal(stored.shareToken, null);
});

test("sanitises before storing and reports what changed", async () => {
  const { reports, deps } = harness();
  const hostile = `${HTML.slice(0, -"</body></html>".length)}<script>alert(1)</script><p onload="x">Body</p></body></html>`;
  const result = await save(deps, { html: hostile });

  assert.equal(result.sanitized.changed, true);
  assert.deepEqual(result.sanitized.removedTags, ["script"]);
  const stored = await reports.getReportWithHtml(BRAND, result.reportId);
  assert.ok(stored);
  assert.equal(stored.html.includes("<script"), false);
  assert.equal(stored.html.includes("onload"), false);
});

test("updates in place, keeping the stored skill, template and attribution", async () => {
  const { reports, templates, deps, clock } = harness();
  const template = randomUUID();
  await templates.insertTemplate({
    id: template,
    brandKey: BRAND,
    name: "Monthly client check-in",
    description: "The monthly update.",
    instructions: "Audience: the client.",
    createdBy: "app",
    createdByUserId: "user-1",
  });
  const original = await seed(reports, {
    title: "Original",
    skill: "seo-audit",
    skillVersion: "1.2.3",
    templateId: template,
    createdBy: "app",
    createdByUserId: "user-original",
  });
  clock.now += 60_000;

  const result = await save(deps, { reportId: original.id, title: "Renamed" });

  assert.equal(result.created, false);
  assert.equal(result.reportId, original.id);
  const stored = await reports.getReportWithHtml(BRAND, original.id);
  assert.ok(stored);
  assert.equal(stored.title, "Renamed");
  assert.equal(stored.skill, "seo-audit");
  assert.equal(stored.skillVersion, "1.2.3");
  assert.equal(stored.templateId, template);
  assert.equal(stored.createdBy, "app");
  assert.equal(stored.createdByUserId, "user-original");
  assert.equal(stored.createdAt, original.createdAt);
  assert.notEqual(stored.updatedAt, original.updatedAt);
  assert.equal(await reports.countReports(BRAND), 1, "an update does not add a row");
});

test("a provided skill replaces the stored one", async () => {
  const { reports, deps } = harness();
  const original = await seed(reports, { skill: "seo-audit" });
  await save(deps, { reportId: original.id, skill: "ai-visibility-audit", skillVersion: "2.0.0" });
  const stored = await reports.getReport(BRAND, original.id);
  assert.equal(stored?.skill, "ai-visibility-audit");
  assert.equal(stored?.skillVersion, "2.0.0");
});

test("trims the title and summary before storing them", async () => {
  const { reports, deps } = harness();
  const result = await save(deps, { title: "  Trimmed  ", summary: "  Verdict.  " });
  assert.equal(result.title, "Trimmed");
  const stored = await reports.getReport(BRAND, result.reportId);
  assert.equal(stored?.title, "Trimmed");
  assert.equal(stored?.summary, "Verdict.");
});

test("refuses an empty title before anything else", async () => {
  const { reports, deps } = harness();
  await refusal(save(deps, { title: "   " }), 400, "title_required", "Give the report a title.");
  assert.equal(await reports.countReports(BRAND), 0);
});

test("refuses an over-long title with the character count", async () => {
  const { reports, deps } = harness();
  await refusal(
    save(deps, { title: "T".repeat(143) }),
    400,
    "title_too_long",
    "Title is 143 characters; the limit is 120. Shorten it and save again."
  );
  assert.equal(await reports.countReports(BRAND), 0);
});

test("refuses an empty summary with the actionable line", async () => {
  const { reports, deps } = harness();
  await refusal(
    save(deps, { summary: "  " }),
    400,
    "summary_required",
    "Add a one-line summary with the verdict, the top action and the key numbers."
  );
  assert.equal(await reports.countReports(BRAND), 0);
});

test("refuses an over-long summary with the character count", async () => {
  const { reports, deps } = harness();
  await refusal(
    save(deps, { summary: "s".repeat(2_720) }),
    400,
    "summary_too_long",
    "Summary is 2,720 characters; the limit is 2,500. Shorten it and save again."
  );
  assert.equal(await reports.countReports(BRAND), 0);
});

test("a bad title beats a bad summary, and a bad summary beats a bad document", async () => {
  const { deps } = harness();
  await refusal(
    save(deps, { title: "T".repeat(121), summary: "s".repeat(2_501), html: "not html" }),
    400,
    "title_too_long",
    "Title is 121 characters; the limit is 120. Shorten it and save again."
  );
  await refusal(
    save(deps, { summary: "s".repeat(2_501), html: "not html" }),
    400,
    "summary_too_long",
    "Summary is 2,501 characters; the limit is 2,500. Shorten it and save again."
  );
});

test("measures the input ceiling in UTF-8 bytes before sanitising", async () => {
  const { reports, deps } = harness();
  // 520,000 two-byte characters: 520,000 code units, 1,040,000 bytes.
  const html = `<!doctype html><html><body><p>${"é".repeat(520_000)}</p></body></html>`;
  assert.ok(byteLength(html) > REPORT_MAX_INPUT_BYTES);
  await refusal(
    save(deps, { html }),
    400,
    "report_too_large",
    "Report is 1,041 KB; the limit is 500 KB. Inlined images are the usual cause. Remove them and save again."
  );
  assert.equal(await reports.countReports(BRAND), 0);
});

test("refuses a document over the stored cap after sanitising", async () => {
  const { reports, deps } = harness();
  // Under the 1,000,000-byte input ceiling, over the 500,000-byte stored cap.
  const html = `<!doctype html><html><body><p>${"a".repeat(499_990)}</p></body></html>`;
  assert.ok(byteLength(html) < REPORT_MAX_INPUT_BYTES);
  await refusal(
    save(deps, { html }),
    400,
    "report_too_large",
    `Report is 501 KB; the limit is ${Math.floor(REPORT_MAX_HTML_BYTES / 1000)} KB. Inlined images are the usual cause. Remove them and save again.`
  );
  assert.equal(await reports.countReports(BRAND), 0);
});

test("accepts a 499,900-byte document and never prints 500 KB twice", async () => {
  const { deps } = harness();
  const prefix = "<!doctype html>\n<html><body><p>";
  const suffix = "</p></body></html>";
  const html = `${prefix}${"a".repeat(499_900 - prefix.length - suffix.length)}${suffix}`;
  assert.equal(byteLength(html), 499_900);
  const result = await save(deps, { html });
  assert.equal(result.htmlBytes, 499_900, "the boundary document is stored whole");

  // One byte more than the cap must refuse, and the two numbers may never
  // round to the same thing: 500,001 bytes reads "501 KB; the limit is 500 KB".
  const over = await save(deps, {
    html: `${prefix}${"a".repeat(500_001 - prefix.length - suffix.length)}${suffix}`,
  })
    .then(() => null)
    .catch((error: unknown) => error as AppError);
  assert.ok(over instanceof AppError);
  assert.equal(over.code, "report_too_large");
  assert.equal(
    over.message,
    "Report is 501 KB; the limit is 500 KB. Inlined images are the usual cause. Remove them and save again."
  );
  assert.equal(over.message.includes("500 KB; the limit is 500 KB"), false);
});

test("refuses a document that stopped mid-write and leaves the stored one unchanged", async () => {
  const { reports, deps } = harness();
  const original = await seed(reports, { html: HTML });

  await refusal(
    save(deps, { reportId: original.id, html: "<html><body>half a report" }),
    400,
    "report_incomplete",
    "The HTML has no closing </html>; the writer stopped early. Write the whole document and save again."
  );
  const stored = await reports.getReportWithHtml(BRAND, original.id);
  assert.equal(stored?.html, HTML);
});

test("refuses a document with no <html", async () => {
  const { deps } = harness();
  await refusal(
    save(deps, { html: "<body><p>fragment only</p></body></html>" }),
    400,
    "report_incomplete",
    "The HTML has no closing </html>; the writer stopped early. Write the whole document and save again."
  );
});

test("refuses a rename onto another report's title and names it", async () => {
  const { reports, deps } = harness();
  const original = await seed(reports, { title: "Original" });
  const clash = await seed(reports, { title: "Taken" });

  await refusal(
    save(deps, { reportId: original.id, title: "Taken" }),
    409,
    "report_title_taken",
    `A report titled 'Taken' exists (id ${clash.id}). Pass reportId to update it, or change the title.`
  );
});

test("allows the same title in a different workspace", async () => {
  const { deps } = harness();
  await seed(deps.store as MemoryReportStore, { brandKey: OTHER_BRAND, title: "Shared title" });
  const result = await save(deps, { title: "Shared title" });
  assert.equal(result.created, true);
});

test("refuses a create at the 2,000-report cap but still updates", async () => {
  const { reports, deps } = harness();
  const existing = await seed(reports);
  for (let index = 1; index < REPORT_MAX_PER_WORKSPACE; index += 1) {
    await reports.insertReport({
      id: randomUUID(),
      brandKey: BRAND,
      title: `Bulk report ${index}`,
      summary: "Bulk.",
      html: HTML,
      skill: null,
      skillVersion: null,
      templateId: null,
      sessionId: null,
      createdBy: "assistant",
      createdByUserId: "user-1",
      sizeBytes: byteLength(HTML),
      sanitizerVersion: 1,
    });
  }
  assert.equal(await reports.countReports(BRAND), REPORT_MAX_PER_WORKSPACE);

  await refusal(
    save(deps),
    409,
    "report_limit",
    `This workspace has ${new Intl.NumberFormat("en-US").format(REPORT_MAX_PER_WORKSPACE)} reports, the limit. Delete one from the Reports page.`
  );
  const updated = await save(deps, { reportId: existing.id, title: "Still editable" });
  assert.equal(updated.created, false);
});

test("refuses a save that would push the workspace over its byte ceiling", async () => {
  const { reports, deps } = harness();
  const atCeiling: MemoryReportStore = {
    ...reports,
    workspaceUsage: async () => ({ reportCount: 1, totalBytes: REPORT_MAX_BYTES_PER_WORKSPACE }),
  };
  await refusal(
    save({ ...deps, store: atCeiling }),
    409,
    "report_storage_limit",
    `This workspace is storing ${new Intl.NumberFormat("en-US").format(REPORT_MAX_BYTES_PER_WORKSPACE / 1_000_000)} MB of reports, the limit. Delete reports you no longer need from the Reports page.`
  );
});

test("counts an update against the ceiling net of the bytes it replaces", async () => {
  const { reports, deps } = harness();
  const big = await seed(reports, {
    html: `<!doctype html><html><body><p>${"a".repeat(9_000)}</p></body></html>`,
  });
  const atCeiling: MemoryReportStore = {
    ...reports,
    workspaceUsage: async () => ({ reportCount: 1, totalBytes: REPORT_MAX_BYTES_PER_WORKSPACE }),
  };
  const result = await save({ ...deps, store: atCeiling }, { reportId: big.id });
  assert.equal(result.created, false);
});

test("refuses an unknown reportId with the save hint", async () => {
  const { deps } = harness();
  const missing = randomUUID();
  await refusal(
    save(deps, { reportId: missing }),
    404,
    "report_not_found",
    `No report ${missing} in this workspace. Call list_reports, or omit reportId to create a new one.`
  );
});

test("refuses a malformed reportId without querying", async () => {
  const { reports, deps } = harness();
  let reads = 0;
  const spied: MemoryReportStore = {
    ...reports,
    getReport: async (...args) => {
      reads += 1;
      return reports.getReport(...args);
    },
  };
  await refusal(
    save({ ...deps, store: spied }, { reportId: "not-a-uuid" }),
    404,
    "report_not_found",
    "No report not-a-uuid in this workspace. Call list_reports, or omit reportId to create a new one."
  );
  assert.equal(reads, 0);
});

test("refuses a template that is not in this workspace", async () => {
  const { deps } = harness();
  const foreign = randomUUID();
  await refusal(
    save(deps, { templateId: foreign }),
    404,
    "template_not_found",
    `No report template ${foreign} in this workspace. Call list_report_templates to see what exists.`
  );
  await refusal(
    save(deps, { templateId: "not-a-uuid" }),
    404,
    "template_not_found",
    "No report template not-a-uuid in this workspace. Call list_report_templates to see what exists."
  );
});

test("a missing template beats a title clash", async () => {
  const { reports, deps } = harness();
  await seed(reports, { title: "Taken" });
  const templateId = randomUUID();
  await refusal(
    save(deps, { title: "Taken", templateId }),
    404,
    "template_not_found",
    `No report template ${templateId} in this workspace. Call list_report_templates to see what exists.`
  );
});

test("stores the templateId it was given", async () => {
  const { templates, deps } = harness();
  const templateId = randomUUID();
  await templates.insertTemplate({
    id: templateId,
    brandKey: BRAND,
    name: "Client check-in",
    description: "Monthly.",
    instructions: "Audience: the client.",
    createdBy: "app",
    createdByUserId: "user-1",
  });
  const result = await save(deps, { templateId });
  const stored = await (deps.store as MemoryReportStore).getReport(BRAND, result.reportId);
  assert.equal(stored?.templateId, templateId);
});

test("emits report:saved with the documented properties", async () => {
  const { deps } = harness();
  const events: Array<{ name: string; props: Record<string, unknown> }> = [];
  setReportEventTracker((name, props) => {
    events.push({ name, props });
  });
  const result = await save(deps, { skill: "seo-audit" });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.name, "report:saved");
  assert.deepEqual(events[0]?.props, {
    skill: "seo-audit",
    used_template: false,
    size_bytes: result.htmlBytes,
    is_update: false,
    sanitized_changed: false,
    source: "assistant",
  });
});

// ---------------------------------------------------------------------------
// reads and delete
// ---------------------------------------------------------------------------

test("lists newest-updated first without html, and reports the room left", async () => {
  const { reports, deps, clock } = harness();
  const first = await seed(reports, { title: "First" });
  clock.now += 1_000;
  const second = await seed(reports, { title: "Second" });

  const result = await listReports(admin, { brandKey: BRAND, limit: 1, offset: 0 }, deps);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0]?.id, second.id);
  assert.equal(result.totalCount, 2);
  assert.equal(result.remaining, REPORT_MAX_PER_WORKSPACE - 2);
  assert.equal("html" in (result.reports[0] as object), false);

  const secondPage = await listReports(admin, { brandKey: BRAND, limit: 1, offset: 1 }, deps);
  assert.equal(secondPage.reports[0]?.id, first.id);
});

test("getReport refuses an unknown, foreign or malformed id with one sentence", async () => {
  const { reports, deps } = harness();
  const foreign = await seed(reports, { brandKey: OTHER_BRAND });
  for (const id of [randomUUID(), foreign.id, "not-a-uuid"]) {
    await refusal(
      getReport(admin, BRAND, id, deps),
      404,
      "report_not_found",
      `No report ${id} in this workspace. Call list_reports to see what exists.`
    );
  }
});

test("getReportWithHtml returns the metadata and the document", async () => {
  const { reports, deps } = harness();
  const seeded = await seed(reports);
  const { report, html } = await getReportWithHtml(admin, BRAND, seeded.id, deps);
  assert.equal(report.id, seeded.id);
  assert.equal(html, HTML);
});

test("deleteReport removes the row and its view rows", async () => {
  const { reports, deps } = harness();
  const seeded = await seed(reports);
  reports.recordView({
    reportId: seeded.id,
    brandKey: BRAND,
    day: "2026-11-17",
    pseudonym: `share:${"a".repeat(16)}`,
    fromBrowser: true,
  });
  await deleteReport(admin, BRAND, seeded.id, deps);
  assert.equal(await reports.countReports(BRAND), 0);
  assert.equal(reports.views.size, 0);
  await refusal(
    deleteReport(admin, BRAND, seeded.id, deps),
    404,
    "report_not_found",
    `No report ${seeded.id} in this workspace. Call list_reports to see what exists.`
  );
});

// ---------------------------------------------------------------------------
// sharing
// ---------------------------------------------------------------------------

test("sharing off refuses with 404 feature_unavailable before reading the report", async () => {
  const { reports, deps } = harness();
  const seeded = await seed(reports);
  let reads = 0;
  const spied: MemoryReportStore = {
    ...reports,
    getReport: async (...args) => {
      reads += 1;
      return reports.getReport(...args);
    },
  };
  await refusal(
    shareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, {
      ...deps,
      store: spied,
      isFeatureEnabled: async () => false,
    }),
    404,
    "feature_unavailable",
    "Public links are not available for this workspace."
  );
  assert.equal(reads, 0);
});

test("mints, revokes and re-mints a different token", async () => {
  const { reports, deps } = harness();
  const seeded = await seed(reports, { skill: "seo-audit" });

  const first = await shareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, deps);
  assert.match(first.shareToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(first.sharedAt, new Date(NOW).toISOString());

  await unshareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, deps);
  const cleared = await reports.getReport(BRAND, seeded.id);
  assert.equal(cleared?.shareToken, null);
  assert.equal(cleared?.sharedAt, null);

  const second = await shareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, deps);
  assert.notEqual(second.shareToken, first.shareToken);
});

test("returns the existing token instead of minting a second one", async () => {
  const { reports, deps } = harness();
  const seeded = await seed(reports);
  const first = await shareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, deps);
  const events: string[] = [];
  setReportEventTracker((name) => {
    events.push(name);
  });

  const second = await shareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, deps);
  assert.deepEqual(second, first);
  assert.deepEqual(events, [], "only the request that created the link emits report:shared");
});

test("a content save never touches the share token", async () => {
  const { reports, deps } = harness();
  const seeded = await seed(reports);
  const shared = await shareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, deps);
  await save(deps, { reportId: seeded.id, title: "Renamed after sharing" });
  const stored = await reports.getReport(BRAND, seeded.id);
  assert.equal(stored?.shareToken, shared.shareToken);
  assert.equal(stored?.sharedAt, shared.sharedAt);
});

test("unsharing a private report is a no-op that emits nothing", async () => {
  const { reports, deps } = harness();
  const seeded = await seed(reports);
  const events: string[] = [];
  setReportEventTracker((name) => {
    events.push(name);
  });
  const result = await unshareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, deps);
  assert.deepEqual(result, { shareToken: null, sharedAt: null });
  assert.deepEqual(events, []);
});

test("sharing emits report:shared and unsharing report:unshared", async () => {
  const { reports, deps } = harness();
  const seeded = await seed(reports, { skill: "ai-visibility-audit" });
  const events: Array<{ name: string; props: Record<string, unknown> }> = [];
  setReportEventTracker((name, props) => {
    events.push({ name, props });
  });
  await shareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, deps);
  await unshareReport(admin, { brandKey: BRAND, reportId: seeded.id, userId: "user-1" }, deps);
  assert.deepEqual(events, [
    { name: "report:shared", props: { skill: "ai-visibility-audit" } },
    { name: "report:unshared", props: { skill: "ai-visibility-audit" } },
  ]);
});

test("sharing a report from another workspace is 404", async () => {
  const { reports, deps } = harness();
  const foreign = await seed(reports, { brandKey: OTHER_BRAND });
  await refusal(
    shareReport(admin, { brandKey: BRAND, reportId: foreign.id, userId: "user-1" }, deps),
    404,
    "report_not_found",
    `No report ${foreign.id} in this workspace. Call list_reports to see what exists.`
  );
});

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

test("viewsLast30Days counts browser views for this link over 30 UTC days", async () => {
  const { reports, deps } = harness();
  const seeded = await seed(reports);
  const token = "a".repeat(32);
  const otherToken = "b".repeat(32);
  const pseudonym = await sharePseudonym(token);
  const otherPseudonym = await sharePseudonym(otherToken);

  reports.recordView({ reportId: seeded.id, brandKey: BRAND, day: "2026-11-17", pseudonym, fromBrowser: true });
  reports.recordView({ reportId: seeded.id, brandKey: BRAND, day: "2026-11-17", pseudonym, fromBrowser: true });
  reports.recordView({ reportId: seeded.id, brandKey: BRAND, day: "2026-10-19", pseudonym, fromBrowser: true });
  // Outside the window.
  reports.recordView({ reportId: seeded.id, brandKey: BRAND, day: "2026-10-18", pseudonym, fromBrowser: true });
  // Another link, another report, and a non-browser view.
  reports.recordView({ reportId: seeded.id, brandKey: BRAND, day: "2026-11-17", pseudonym: otherPseudonym, fromBrowser: true });
  const otherReport = await seed(reports);
  reports.recordView({ reportId: otherReport.id, brandKey: BRAND, day: "2026-11-17", pseudonym, fromBrowser: true });
  reports.recordView({ reportId: seeded.id, brandKey: BRAND, day: "2026-11-17", pseudonym, fromBrowser: false });

  const views = await viewsLast30Days(
    admin,
    { brandKey: BRAND, reportId: seeded.id, shareToken: token },
    deps
  );
  assert.equal(views, 3);
});

test("viewsLast30Days answers 0 for a private report without asking the store", async () => {
  const { reports, deps } = harness();
  let asked = 0;
  const spied: MemoryReportStore = {
    ...reports,
    sumBrowserViews: async () => {
      asked += 1;
      return 0;
    },
  };
  assert.equal(
    await viewsLast30Days(admin, { brandKey: BRAND, reportId: randomUUID(), shareToken: "" }, {
      ...deps,
      store: spied,
    }),
    0
  );
  assert.equal(asked, 0);
});
