import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMemoryStores } from "./memoryStore.ts";
import {
  getReportTool,
  listReportTemplatesTool,
  listReportsTool,
  saveReportTool,
} from "./tools.ts";
import { registrations } from "../tools/catalog/reports.ts";

const admin = {} as SupabaseClient;
const BRAND = "brand-a";
const HTML = "<!doctype html>\n<html><body><p>Report</p></body></html>";

function ctx(over: Record<string, unknown> = {}) {
  return {
    admin,
    brand: { brandKey: BRAND, display_name: "Acme", website: "https://acme.example", website_host: "acme.example", aliases: [], is_active: true, role: "owner" },
    userId: "user-1",
    user: { id: "user-1", email: "owner@acme.example" },
    role: "owner",
    requestId: "test",
    source: "test",
    ...over,
  } as never;
}

function stores() {
  return createMemoryStores({ now: () => new Date("2026-11-17T12:00:00.000Z") });
}

test("list_reports: previews, counts and never a token or URL", async () => {
  const { reports, templates } = stores();
  const deps = { reportStore: reports, templateStore: templates };
  const longSummary = "v".repeat(400);
  await (await import("./service.ts")).saveReport(
    admin,
    { brandKey: BRAND, title: "Audit — Nov 17, 2026", summary: longSummary, html: HTML, createdBy: "assistant", createdByUserId: "user-1" },
    { store: reports, templates },
  );
  const out = await listReportsTool.handler(ctx({ deps }), { limit: 20, offset: 0 });
  assert.equal(out.totalCount, 1);
  assert.equal(out.rowCount, 1);
  assert.equal(out.remaining, 1999);
  assert.equal(out.reports.length, 1);
  const row = out.reports[0];
  assert.equal(row.title, "Audit — Nov 17, 2026");
  assert.ok(row.summaryPreview.length <= 301);
  assert.ok(row.summaryPreview.endsWith("\u2026"));
  assert.ok(!("shareToken" in row));
  assert.ok(!("summary" in row));
  assert.ok(!JSON.stringify(out).includes("/s/"));
  assert.ok(!JSON.stringify(out).includes("shareToken"));
});

test("get_report: metadata only by default, html only on request, never a token or URL", async () => {
  const { reports, templates } = stores();
  const deps = { reportStore: reports, templateStore: templates };
  const saved = await (await import("./service.ts")).saveReport(
    admin,
    { brandKey: BRAND, title: "Audit — Nov 17, 2026", summary: "Verdict.", html: HTML, createdBy: "assistant", createdByUserId: "user-1" },
    { store: reports, templates },
  );
  const without = await getReportTool.handler(ctx({ deps }), { reportId: saved.reportId, includeHtml: false });
  assert.equal(without.report.id, saved.reportId);
  assert.equal(without.report.html, undefined);
  assert.ok(!("shareToken" in without.report));
  assert.ok(!JSON.stringify(without).includes("/s/"));
  const withHtml = await getReportTool.handler(ctx({ deps }), { reportId: saved.reportId, includeHtml: true });
  assert.equal(withHtml.report.html, HTML);
  assert.ok(!("shareToken" in withHtml.report));
});

test("save_report: creates and replaces, stamping the skill version and session", async () => {
  const { reports, templates } = stores();
  const deps = { reportStore: reports, templateStore: templates };
  const created = await saveReportTool.handler(
    ctx({ deps, sessionId: "s-1" }),
    { title: "Audit — Nov 17, 2026", summary: "Verdict.", html: HTML, skill: "ai-visibility-audit" },
  );
  assert.equal(created.created, true);
  assert.equal(created.path, `/portal/reports/${created.reportId}`);
  assert.deepEqual(created.sanitized, { changed: false, removedTags: [] });
  const stored = await reports.getReport(BRAND, created.reportId);
  assert.equal(stored?.skill, "ai-visibility-audit");
  assert.equal(stored?.skillVersion, "1.0.0");
  const replaced = await saveReportTool.handler(
    ctx({ deps, sessionId: "s-1" }),
    { reportId: created.reportId, title: "Audit — Nov 17, 2026", summary: "Verdict 2.", html: HTML },
  );
  assert.equal(replaced.created, false);
  assert.equal(replaced.reportId, created.reportId);
});

test("list_report_templates: returns the briefs and the room left", async () => {
  const { reports, templates } = stores();
  const deps = { reportStore: reports, templateStore: templates };
  await (await import("./templateService.ts")).saveReportTemplate(
    admin,
    { brandKey: BRAND, name: "Monthly", description: "Monthly update.", instructions: "Audience: lead.", createdBy: "app", createdByUserId: "user-1" },
    { store: templates },
  );
  const out = await listReportTemplatesTool.handler(ctx({ deps }), {});
  assert.equal(out.templates.length, 1);
  assert.equal(out.templates[0]?.name, "Monthly");
  assert.equal(out.remaining, 9);
});

test("catalog: areas, gates, effects, approvals, annotations, links and untrusted paths", async () => {
  const byName = new Map(registrations.map((reg) => [reg.def.name, reg]));
  assert.deepEqual([...byName.keys()].sort(), ["get_report", "list_report_templates", "list_reports", "save_report"]);
  for (const reg of registrations) {
    assert.equal(reg.area, "reports");
    assert.equal(reg.feature, "reports");
  }
  const readNames = ["list_reports", "get_report", "list_report_templates"];
  for (const name of readNames) {
    const reg = byName.get(name)!;
    assert.equal(reg.effect, "read");
    assert.deepEqual(await reg.approval({} as never, {}), { kind: "none" });
    assert.equal(reg.annotations.readOnlyHint, true);
    assert.equal(reg.annotations.destructiveHint, false);
  }
  const save = byName.get("save_report")!;
  assert.equal(save.effect, "write");
  assert.equal(save.annotations.destructiveHint, true);
  // The replace confirmation reads through the service, with the same injected
  // store as the handler, so it can be shown against an in-memory store.
  const { reports, templates } = stores();
  const deps = { reportStore: reports, templateStore: templates };
  assert.deepEqual(await save.approval(ctx({ deps }), {}), { kind: "none" }, "no reportId: a create, nothing to replace");
  const OLD_ID = "1f0c9a2b-3d4e-4f5a-9a1b-2f0c4d5e6a7b";
  assert.deepEqual(await save.approval(ctx({ deps }), { reportId: OLD_ID }), { kind: "none" }, "unknown id: the save itself refuses it");
  assert.deepEqual(await save.approval(ctx({ deps }), { reportId: "not-a-uuid" }), { kind: "none" }, "malformed id fails the service id check");
  const saved = await (await import("./service.ts")).saveReport(
    admin,
    { brandKey: BRAND, title: "Old report", summary: "S.", html: HTML, createdBy: "assistant", createdByUserId: "user-1" },
    { store: reports, templates },
  );
  assert.deepEqual(
    await save.approval(ctx({ deps }), { reportId: saved.reportId }),
    { kind: "confirm", label: "Replace the report \u201COld report\u201D" },
  );
  // Another workspace's report is not found, so it neither confirms nor leaks its title.
  assert.deepEqual(
    await save.approval(ctx({ deps, brand: { brandKey: "brand-b" } }), { reportId: saved.reportId }),
    { kind: "none" },
  );
  // A failed read must not quietly skip the confirmation of an overwrite.
  const broken = {
    ...reports,
    getReport: async () => {
      throw new Error("storage down");
    },
  };
  await assert.rejects(async () => save.approval(ctx({ deps: { reportStore: broken } }), { reportId: saved.reportId }), /storage down/);
  assert.deepEqual(byName.get("list_reports")!.untrustedPaths, ["reports[*].summaryPreview"]);
  assert.deepEqual(byName.get("get_report")!.untrustedPaths, ["report.summary", "report.html"]);
  // Summaries use the ported upstream size copy.
  assert.equal(byName.get("list_reports")!.summarize({ rowCount: 2, totalCount: 5 }, {}), "2 of 5 reports.");
  assert.equal(
    byName.get("get_report")!.summarize({ report: { title: "T", htmlBytes: 500 } }, {}),
    "Report \u201CT\u201D (500 bytes).",
  );
  assert.equal(
    byName.get("get_report")!.summarize({ report: { title: "T", htmlBytes: 21480 } }, {}),
    "Report \u201CT\u201D (21 KB).",
  );
  assert.equal(
    byName.get("save_report")!.summarize({ title: "T", htmlBytes: 500, created: true }, {}),
    "Saved report \u201CT\u201D (500 bytes).",
  );
  assert.equal(
    byName.get("save_report")!.summarize({ title: "T", htmlBytes: 21480, created: false }, {}),
    "Replaced report \u201CT\u201D (21 KB).",
  );
  assert.equal(byName.get("list_report_templates")!.summarize({ templates: [{}, {}] }, {}), "2 report templates.");
  // Links never contain a token.
  for (const reg of registrations) {
    const link = reg.link?.({ reportId: "id-1", report: { id: "id-1" } } as never, {} as never);
    if (link) {
      assert.ok(link.path.startsWith("/portal/reports"));
      assert.ok(!link.path.includes("/s/"));
    }
  }
});

test("tool descriptions are the exact §6.2.4 copy", () => {
  const byName = new Map(registrations.map((reg) => [reg.def.name, reg.def.description]));
  assert.equal(
    byName.get("save_report"),
    "Save a finished, self-contained HTML report to this workspace, where the team can read and print it. New reports are private; only a person can share them from Reports. Call list_reports first and pass the reportId of the report you are redoing instead of creating a near-duplicate; a title already used in this workspace is refused. Give a specific title (the report type or subject and the full date), a summary with the verdict, the top action and the key numbers, and the skill name you are running. Scripts, forms, iframes, remote images and fonts are removed when saved. Then reply with the returned path, a one-line verdict and the top action; do not paste the report into chat.",
  );
  assert.equal(
    byName.get("list_reports"),
    "List this workspace's saved reports, newest first: id, title, skill, size, update time and a short summary preview. Call this before save_report so you replace the right report instead of making a near-duplicate.",
  );
  assert.equal(
    byName.get("get_report"),
    "Read one saved report: title, summary, skill and size. Pass includeHtml only when you must edit a specific passage; a large report is long. Reading never shares a report.",
  );
  assert.equal(
    byName.get("list_report_templates"),
    "List this workspace's report templates: the user's briefs for kinds of report (audience, sections, tone, sign-off). Use one only when the user names it or asks for the kind of report it describes, and pass its id to save_report.",
  );
});
