/**
 * F23 P3.T1.S2 — customer report routes through the real handlers and the real
 * service, backed by the in-memory stores. No database, no provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { randomUUID } from "node:crypto";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const listRoute = await import("../../app/api/customer/reports/route.ts");
const detailRoute = await import("../../app/api/customer/reports/[reportId]/route.ts");
const shareRoute = await import("../../app/api/customer/reports/[reportId]/share/route.ts");
const templatesRoute = await import("../../app/api/customer/reports/templates/route.ts");
const templateItemRoute = await import("../../app/api/customer/reports/templates/[templateId]/route.ts");
const generateRoute = await import("../../app/api/customer/reports/generate/route.ts");
const { createMemoryStores } = await import("./memoryStore.ts");
const service = await import("./service.ts");
const templateService = await import("./templateService.ts");
const { sharePseudonym } = await import("../../shared/report-share.ts");

const USER = { id: "user-1", email: "owner@acme.example" };
const BRAND_A = {
  brandKey: "brand-a",
  role: "owner",
  display_name: "Acme",
  website: "https://acme.example",
  website_host: "acme.example",
  aliases: [],
  is_active: true,
};
const BRAND_B = {
  brandKey: "brand-b",
  role: "owner",
  display_name: "Other",
  website: "https://other.example",
  website_host: "other.example",
  aliases: [],
  is_active: true,
};
const NOW = new Date("2026-11-17T12:00:00.000Z");
const HTML = "<!doctype html>\n<html><body><p>Report</p></body></html>";

function baseDeps(stores, over = {}) {
  return {
    getCustomerContext: async () => ({ client: null, user: USER, brands: [BRAND_A, BRAND_B], error: null }),
    getSupabaseAdmin: () => ({}),
    isFeatureEnabled: async () => true,
    ...over,
  };
}

function serviceDeps(stores) {
  return {
    store: stores.reports,
    templates: stores.templates,
    isFeatureEnabled: async () => true,
    now: () => NOW,
  };
}

function listDeps(stores, over = {}) {
  return baseDeps(stores, {
    listReports: (admin, input) => service.listReports(admin, input, serviceDeps(stores)),
    listReportTemplates: (admin, brandKey) => templateService.listReportTemplates(admin, brandKey, { store: stores.templates }),
    getSkillTitle: (skill) => (skill === "ai-visibility-audit" ? "AI Visibility Audit" : null),
    ...over,
  });
}

function detailDeps(stores, sessions, over = {}) {
  return baseDeps(stores, {
    getReport: (admin, brandKey, id) => service.getReport(admin, brandKey, id, serviceDeps(stores)),
    deleteReport: (admin, brandKey, id) => service.deleteReport(admin, brandKey, id, serviceDeps(stores)),
    listReportTemplates: (admin, brandKey) => templateService.listReportTemplates(admin, brandKey, { store: stores.templates }),
    viewsLast30Days: (admin, input) => service.viewsLast30Days(admin, input, serviceDeps(stores)),
    getSkillTitle: (skill) => (skill === "ai-visibility-audit" ? "AI Visibility Audit" : null),
    getChatPath: async (_admin, { brandKey, userId, sessionId }) => {
      if (!sessionId) return null;
      const sess = sessions.get(sessionId);
      if (!sess || sess.archivedAt || sess.brandKey !== brandKey || sess.userId !== userId) return null;
      return `/portal/assistant?s=${sessionId}`;
    },
    ...over,
  });
}

async function read(res) {
  return { status: res.status, cache: res.headers.get("cache-control"), body: await res.json() };
}

function get(url) {
  return new Request(`https://app.test${url}`);
}

function post(url, body) {
  return new Request(`https://app.test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function put(url, body) {
  return new Request(`https://app.test${url}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(url, body) {
  return new Request(`https://app.test${url}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

test("AC-21: list has no html/summary/token and resolves display names", async () => {
  const stores = createMemoryStores({ now: () => NOW });
  const sessions = new Map();
  const template = await templateService.saveReportTemplate(
    {},
    { brandKey: "brand-a", name: "Monthly", description: "Monthly update.", instructions: "Audience: lead.", createdBy: "app", createdByUserId: USER.id },
    { store: stores.templates },
  );
  await service.saveReport(
    {},
    { brandKey: "brand-a", title: "Audit — Oct 22, 2026", summary: "Verdict.", html: HTML, skill: "ai-visibility-audit", templateId: template.templateId, createdBy: "assistant", createdByUserId: USER.id },
    serviceDeps(stores),
  );
  const res = await listRoute.GET(get("/api/customer/reports?brand_key=brand-a"), {}, listDeps(stores));
  const { status, cache, body } = await read(res);
  assert.equal(status, 200);
  assert.equal(cache, "no-store");
  assert.equal(body.reports.length, 1);
  const row = body.reports[0];
  assert.equal(row.title, "Audit — Oct 22, 2026");
  assert.equal(row.skill, "ai-visibility-audit");
  assert.equal(row.skillTitle, "AI Visibility Audit");
  assert.equal(row.templateId, template.templateId);
  assert.equal(row.templateName, "Monthly");
  assert.equal(row.createdBy, "assistant");
  assert.equal(row.createdByYou, true);
  assert.equal(row.shared, false);
  assert.ok(!("html" in row));
  assert.ok(!("summary" in row));
  assert.ok(!("shareToken" in row));
  assert.ok(!JSON.stringify(body).includes("/s/"));
});

test("AC-21: detail has shareToken/sharedAt/views30d/chatPath; delete removes", async () => {
  const stores = createMemoryStores({ now: () => NOW });
  const sessions = new Map();
  const sessId = "sess-1";
  sessions.set(sessId, { id: sessId, brandKey: "brand-a", userId: USER.id });
  const saved = await service.saveReport(
    {},
    { brandKey: "brand-a", title: "Audit — Oct 22, 2026", summary: "Verdict.", html: HTML, sessionId: sessId, createdBy: "assistant", createdByUserId: USER.id },
    serviceDeps(stores),
  );
  // Link the session by re-inserting with sessionId (save keeps session only on create).
  stores.reports.reports.get(saved.reportId).sessionId = sessId;
  const shared = await service.shareReport({}, { brandKey: "brand-a", reportId: saved.reportId, userId: USER.id }, serviceDeps(stores));
  const pseudo = await sharePseudonym(shared.shareToken);
  stores.reports.recordView({ reportId: saved.reportId, brandKey: "brand-a", day: "2026-11-17", pseudonym: pseudo, fromBrowser: true });
  stores.reports.recordView({ reportId: saved.reportId, brandKey: "brand-a", day: "2026-11-17", pseudonym: pseudo, fromBrowser: true });

  const res = await detailRoute.GET(
    get(`/api/customer/reports/${saved.reportId}?brand_key=brand-a`),
    { params: { reportId: saved.reportId } },
    detailDeps(stores, sessions),
  );
  const { status, body } = await read(res);
  assert.equal(status, 200);
  assert.equal(body.report.id, saved.reportId);
  assert.equal(body.report.shareToken, shared.shareToken);
  assert.equal(body.report.sharedAt, shared.sharedAt);
  assert.equal(body.report.views30d, 2);
  assert.equal(body.report.chatPath, "/portal/assistant?s=sess-1");

  const delRes = await detailRoute.DELETE(
    del(`/api/customer/reports/${saved.reportId}`, { brand_key: "brand-a" }),
    { params: { reportId: saved.reportId } },
    detailDeps(stores, sessions),
  );
  const delBody = await read(delRes);
  assert.equal(delBody.status, 200);
  assert.deepEqual(delBody.body, { reportId: saved.reportId, deleted: true });

  const gone = await detailRoute.GET(
    get(`/api/customer/reports/${saved.reportId}?brand_key=brand-a`),
    { params: { reportId: saved.reportId } },
    detailDeps(stores, sessions),
  );
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).code, "report_not_found");
});

test("AC-21: share/unshare round-trips; sharing off is 404 feature_unavailable", async () => {
  const stores = createMemoryStores({ now: () => NOW });
  const sessions = new Map();
  const saved = await service.saveReport(
    {},
    { brandKey: "brand-a", title: "Share me", summary: "Verdict.", html: HTML, createdBy: "assistant", createdByUserId: USER.id },
    serviceDeps(stores),
  );
  const deps = baseDeps(stores, {
    shareReport: (admin, input) => service.shareReport(admin, input, serviceDeps(stores)),
    unshareReport: (admin, input) => service.unshareReport(admin, input, serviceDeps(stores)),
  });
  const on = await shareRoute.POST(
    post(`/api/customer/reports/${saved.reportId}/share`, { brand_key: "brand-a", public: true }),
    { params: { reportId: saved.reportId } },
    deps,
  );
  assert.equal(on.status, 200);
  const onBody = await on.json();
  assert.match(onBody.shareToken, /^[A-Za-z0-9_-]{32}$/);

  const off = await shareRoute.POST(
    post(`/api/customer/reports/${saved.reportId}/share`, { brand_key: "brand-a", public: false }),
    { params: { reportId: saved.reportId } },
    deps,
  );
  assert.deepEqual(await off.json(), { shareToken: null, sharedAt: null });

  const flagOff = baseDeps(stores, {
    isFeatureEnabled: async (name) => name !== "report_sharing",
    shareReport: (admin, input) => service.shareReport(admin, input, { ...serviceDeps(stores), isFeatureEnabled: async () => false }),
    unshareReport: (admin, input) => service.unshareReport(admin, input, serviceDeps(stores)),
  });
  // The route's own reports flag is on; the service refuses the sharing flag.
  const refused = await shareRoute.POST(
    post(`/api/customer/reports/${saved.reportId}/share`, { brand_key: "brand-a", public: true }),
    { params: { reportId: saved.reportId } },
    { ...flagOff, isFeatureEnabled: async (name) => (name === "reports" ? true : name !== "report_sharing") },
  );
  // Route checks reports, service checks report_sharing.
  const refusedBody = await refused.json();
  assert.equal(refused.status, 404);
  assert.equal(refusedBody.code, "feature_unavailable");
});

test("AC-21: foreign workspace ids are 404; unknown fields are rejected", async () => {
  const stores = createMemoryStores({ now: () => NOW });
  const sessions = new Map();
  const foreign = await service.saveReport(
    {},
    { brandKey: "brand-b", title: "Other workspace", summary: "Verdict.", html: HTML, createdBy: "assistant", createdByUserId: "other" },
    serviceDeps(stores),
  );
  const res = await detailRoute.GET(
    get(`/api/customer/reports/${foreign.reportId}?brand_key=brand-a`),
    { params: { reportId: foreign.reportId } },
    detailDeps(stores, sessions),
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "report_not_found");

  const badList = await listRoute.GET(get("/api/customer/reports?brand_key=brand-a&unexpected=1"), {}, listDeps(stores));
  assert.equal(badList.status, 400);
  assert.equal((await badList.json()).code, "invalid_request");

  const badShare = await shareRoute.POST(
    post(`/api/customer/reports/${foreign.reportId}/share`, { brand_key: "brand-a", public: true, extra: 1 }),
    { params: { reportId: foreign.reportId } },
    baseDeps(stores, {
      shareReport: (admin, input) => service.shareReport(admin, input, serviceDeps(stores)),
      unshareReport: (admin, input) => service.unshareReport(admin, input, serviceDeps(stores)),
    }),
  );
  assert.equal(badShare.status, 400);
});

test("AC-21: reports flag off hides every route with 404 feature_unavailable", async () => {
  const stores = createMemoryStores({ now: () => NOW });
  const off = baseDeps(stores, { isFeatureEnabled: async () => false });
  const id = randomUUID();
  const cases = [
    listRoute.GET(get("/api/customer/reports?brand_key=brand-a"), {}, off),
    detailRoute.GET(get(`/api/customer/reports/${id}?brand_key=brand-a`), { params: { reportId: id } }, off),
    detailRoute.DELETE(del(`/api/customer/reports/${id}`, { brand_key: "brand-a" }), { params: { reportId: id } }, off),
    shareRoute.POST(post(`/api/customer/reports/${id}/share`, { brand_key: "brand-a", public: true }), { params: { reportId: id } }, off),
    templatesRoute.GET(get("/api/customer/reports/templates?brand_key=brand-a"), {}, off),
    templatesRoute.POST(post("/api/customer/reports/templates", { name: "N", description: "D", instructions: "I" }), {}, off),
    templateItemRoute.PUT(put(`/api/customer/reports/templates/${id}`, { name: "N", description: "D", instructions: "I" }), { params: { templateId: id } }, off),
    templateItemRoute.DELETE(del(`/api/customer/reports/templates/${id}`, {}), { params: { templateId: id } }, off),
  ];
  for (const p of cases) {
    const res = await p;
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "feature_unavailable");
  }
});

test("AC-18: templates create/update/delete with caps; deleting leaves reports intact", async () => {
  const stores = createMemoryStores({ now: () => NOW });
  const deps = baseDeps(stores, {
    listReportTemplates: (admin, brandKey) => templateService.listReportTemplates(admin, brandKey, { store: stores.templates }),
    saveReportTemplate: (admin, input) => templateService.saveReportTemplate(admin, input, { store: stores.templates }),
    deleteReportTemplate: (admin, brandKey, id) => templateService.deleteReportTemplate(admin, brandKey, id, { store: stores.templates }),
  });
  const created = await templatesRoute.POST(
    post("/api/customer/reports/templates", { brand_key: "brand-a", name: "Monthly", description: "Monthly update.", instructions: "Audience: lead." }),
    {},
    deps,
  );
  assert.equal(created.status, 201);
  const { templateId } = await created.json();

  const listed = await templatesRoute.GET(get("/api/customer/reports/templates?brand_key=brand-a"), {}, deps);
  assert.equal((await listed.json()).remaining, 9);

  const updated = await templateItemRoute.PUT(
    put(`/api/customer/reports/templates/${templateId}`, { brand_key: "brand-a", name: "Monthly v2", description: "Monthly update.", instructions: "Audience: lead." }),
    { params: { templateId } },
    deps,
  );
  assert.deepEqual(await updated.json(), { templateId, created: false });

  const saved = await service.saveReport(
    {},
    { brandKey: "brand-a", title: "Uses template", summary: "Verdict.", html: HTML, templateId, createdBy: "assistant", createdByUserId: USER.id },
    serviceDeps(stores),
  );
  const deleted = await templateItemRoute.DELETE(
    del(`/api/customer/reports/templates/${templateId}`, { brand_key: "brand-a" }),
    { params: { templateId } },
    deps,
  );
  assert.deepEqual(await deleted.json(), { templateId, deleted: true });

  const sessions = new Map();
  const detail = await detailRoute.GET(
    get(`/api/customer/reports/${saved.reportId}?brand_key=brand-a`),
    { params: { reportId: saved.reportId } },
    detailDeps(stores, sessions),
  );
  const detailBody = await detail.json();
  assert.equal(detailBody.report.templateId, templateId);
  assert.equal(detailBody.report.templateName, null);
});

test("AC-19: generate requires flags, creates a titled session with kickoff and returns its path", async () => {
  const stores = createMemoryStores({ now: () => NOW });
  const template = await templateService.saveReportTemplate(
    {},
    { brandKey: "brand-a", name: "Monthly", description: "Monthly update.", instructions: "Audience: lead.", createdBy: "app", createdByUserId: USER.id },
    { store: stores.templates },
  );
  const createdSessions = [];
  const deps = baseDeps(stores, {
    startReportGeneration: async (ws, input) => {
      const { startReportGeneration } = await import("./generate.ts");
      return startReportGeneration(ws, input, {
        isFeatureEnabled: async () => true,
        getReportTemplate: (admin, brandKey, id) => templateService.getReportTemplate(admin, brandKey, id, { store: stores.templates }),
        createSession: async (_admin, input) => {
          const session = { id: randomUUID(), brandKey: input.brandKey, userId: input.userId, title: input.title ?? "New chat", summary: null, compactedThroughSeq: null, kickoff: input.kickoff ?? null, archivedAt: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
          createdSessions.push(session);
          return session;
        },
      });
    },
  });
  const res = await generateRoute.POST(
    post("/api/customer/reports/generate", { brand_key: "brand-a", templateId: template.templateId }),
    {},
    deps,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.sessionId);
  assert.equal(body.path, `/portal/assistant?s=${body.sessionId}`);
  const session = createdSessions.find((s) => s.id === body.sessionId);
  assert.ok(session);
  assert.equal(session.title, "Report: Monthly");
  assert.deepEqual(session.kickoff, { kind: "generate_report", templateId: template.templateId });

  const missing = await generateRoute.POST(
    post("/api/customer/reports/generate", { brand_key: "brand-a", templateId: randomUUID() }),
    {},
    deps,
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "template_not_found");

  const bad = await generateRoute.POST(
    post("/api/customer/reports/generate", { brand_key: "brand-a", templateId: template.templateId, extra: 1 }),
    {},
    deps,
  );
  assert.equal(bad.status, 400);
});

test("detail: one report read, the chat link comes from the report's own session id, templates are read only when needed", async () => {
  const stores = createMemoryStores({ now: () => NOW });
  const sessions = new Map([["sess-9", { id: "sess-9", brandKey: "brand-a", userId: USER.id }]]);
  const plain = await service.saveReport(
    {},
    { brandKey: "brand-a", title: "No template", summary: "S.", html: HTML, sessionId: "sess-9", createdBy: "assistant", createdByUserId: USER.id },
    serviceDeps(stores),
  );
  const template = await templateService.saveReportTemplate(
    {},
    { brandKey: "brand-a", name: "Monthly", description: "d", instructions: "i", createdBy: "app", createdByUserId: USER.id },
    { store: stores.templates },
  );
  const withTemplate = await service.saveReport(
    {},
    { brandKey: "brand-a", title: "With template", summary: "S.", html: HTML, templateId: template.templateId, createdBy: "assistant", createdByUserId: USER.id },
    serviceDeps(stores),
  );

  const counts = { getReport: 0, templates: 0 };
  const chatArgs = [];
  const deps = () =>
    detailDeps(stores, sessions, {
      getReport: (admin, brandKey, id) => {
        counts.getReport += 1;
        return service.getReport(admin, brandKey, id, serviceDeps(stores));
      },
      listReportTemplates: (admin, brandKey) => {
        counts.templates += 1;
        return templateService.listReportTemplates(admin, brandKey, { store: stores.templates });
      },
      getChatPath: async (_admin, input) => {
        chatArgs.push(input);
        return input.sessionId && sessions.has(input.sessionId) ? `/portal/assistant?s=${input.sessionId}` : null;
      },
    });

  const first = await read(
    await detailRoute.GET(get(`/api/customer/reports/${plain.reportId}?brand_key=brand-a`), { params: { reportId: plain.reportId } }, deps()),
  );
  assert.equal(first.body.report.chatPath, "/portal/assistant?s=sess-9");
  assert.equal(first.body.report.templateName, null);
  assert.deepEqual(counts, { getReport: 1, templates: 0 }, "no template on the report: the template list is never read");
  assert.deepEqual(chatArgs[0], { brandKey: "brand-a", userId: USER.id, sessionId: "sess-9" });

  const second = await read(
    await detailRoute.GET(get(`/api/customer/reports/${withTemplate.reportId}?brand_key=brand-a`), { params: { reportId: withTemplate.reportId } }, deps()),
  );
  assert.equal(second.body.report.templateName, "Monthly");
  assert.equal(second.body.report.chatPath, null, "a report with no session has no chat link");
  assert.deepEqual(counts, { getReport: 2, templates: 1 });
  assert.equal(chatArgs[1].sessionId, null);
});
