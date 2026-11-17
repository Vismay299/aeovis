// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/services/ReportTemplateService.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import { REPORT_TEMPLATE_MAX_PER_WORKSPACE } from "../../shared/reports.ts";
import { createMemoryStores, type MemoryReportStore } from "./memoryStore.ts";
import {
  deleteReportTemplate,
  getReportTemplate,
  listReportTemplates,
  saveReportTemplate,
  type ReportTemplateServiceDeps,
} from "./templateService.ts";

// F23-AC-18: templates create, update, delete; caps 10 / 80 / 200 / 3,000;
// case-insensitive unique names; exact copy; deleting a template leaves reports
// intact.

const NOW = "2026-11-17T12:00:00.000Z";
const BRAND = "brand-a";
const admin = {} as SupabaseClient;

function harness(overrides: Partial<ReportTemplateServiceDeps> = {}) {
  let nowMs = Date.parse(NOW);
  const { reports, templates } = createMemoryStores({ now: () => new Date(nowMs) });
  const deps: ReportTemplateServiceDeps = { store: templates, ...overrides };
  return { reports, templates, deps, advance: (ms: number) => (nowMs += ms) };
}

function save(
  deps: ReportTemplateServiceDeps,
  overrides: Partial<Parameters<typeof saveReportTemplate>[1]> = {}
) {
  return saveReportTemplate(
    admin,
    {
      brandKey: BRAND,
      name: "Client-ready audit summary",
      description: "For the site owner, non-technical.",
      instructions: "Audience: the site owner. Sections: what we found.",
      createdBy: "app",
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

async function seedTemplate(
  deps: ReportTemplateServiceDeps,
  overrides: Partial<Parameters<typeof saveReportTemplate>[1]> = {}
) {
  return save(deps, overrides);
}

test("creates a template with trimmed values and reports the room left", async () => {
  const { templates, deps } = harness();
  const result = await save(deps, {
    name: "  Monthly client check-in  ",
    description: "  The monthly update.  ",
    instructions: "  Audience: the client.  ",
  });
  assert.equal(result.created, true);
  assert.equal(result.name, "Monthly client check-in");
  assert.equal(result.templateId.length, 36);

  const stored = await getReportTemplate(admin, BRAND, result.templateId, deps);
  assert.equal(stored.name, "Monthly client check-in");
  assert.equal(stored.description, "The monthly update.");
  assert.equal(stored.instructions, "Audience: the client.");
  assert.equal(stored.createdBy, "app");
  assert.equal(stored.createdByUserId, "user-1");

  const list = await listReportTemplates(admin, BRAND, deps);
  assert.equal(list.templates.length, 1);
  assert.equal(list.remaining, REPORT_TEMPLATE_MAX_PER_WORKSPACE - 1);
  assert.equal(templates.templates.size, 1);
});

test("updates by id instead of inserting and keeps the attribution", async () => {
  const { templates, deps, advance } = harness();
  const original = await seedTemplate(deps);
  const before = await getReportTemplate(admin, BRAND, original.templateId, deps);
  advance(60_000);

  const result = await save(deps, { templateId: original.templateId, name: "Renamed" });
  assert.deepEqual(result, { templateId: original.templateId, name: "Renamed", created: false });
  assert.equal(templates.templates.size, 1);
  const after = await getReportTemplate(admin, BRAND, original.templateId, deps);
  assert.equal(after.name, "Renamed");
  assert.equal(after.createdBy, "app");
  assert.equal(after.createdByUserId, "user-1");
  assert.equal(after.createdAt, before.createdAt);
  assert.notEqual(after.updatedAt, before.updatedAt);
});

test("lists templates by name with a total order", async () => {
  const { deps } = harness();
  await save(deps, { name: "Zebra" });
  await save(deps, { name: "Alpha" });
  await save(deps, { name: "Middle" });
  const list = await listReportTemplates(admin, BRAND, deps);
  assert.deepEqual(list.templates.map((template) => template.name), ["Alpha", "Middle", "Zebra"]);
});

test("refuses an unknown templateId on save, read and delete", async () => {
  const { deps } = harness();
  const missing = randomUUID();
  const message = `No report template ${missing} in this workspace. Call list_report_templates to see what exists.`;
  await refusal(save(deps, { templateId: missing }), 404, "template_not_found", message);
  await refusal(getReportTemplate(admin, BRAND, missing, deps), 404, "template_not_found", message);
  await refusal(deleteReportTemplate(admin, BRAND, missing, deps), 404, "template_not_found", message);
});

test("refuses a malformed templateId without querying", async () => {
  const { templates, deps } = harness();
  let reads = 0;
  const spied = {
    ...templates,
    getTemplate: async (...args: Parameters<typeof templates.getTemplate>) => {
      reads += 1;
      return templates.getTemplate(...args);
    },
  };
  await refusal(
    getReportTemplate(admin, BRAND, "not-a-uuid", { store: spied }),
    404,
    "template_not_found",
    "No report template not-a-uuid in this workspace. Call list_report_templates to see what exists."
  );
  assert.equal(reads, 0);
});

test("refuses a duplicate name in another case", async () => {
  const { deps } = harness();
  await seedTemplate(deps, { name: "client-ready AUDIT summary" });
  await refusal(
    save(deps, { name: "Client-Ready Audit Summary" }),
    409,
    "template_name_taken",
    'A template named "Client-Ready Audit Summary" exists in this workspace. Choose another name.'
  );
});

test("renaming a template to its own name in another case is allowed", async () => {
  const { deps } = harness();
  const original = await seedTemplate(deps, { name: "Audit summary" });
  const result = await save(deps, { templateId: original.templateId, name: "AUDIT SUMMARY" });
  assert.equal(result.created, false);
});

test("SF-4 — an upper-cased id updates instead of a false 404", async () => {
  const { deps } = harness();
  const created = await seedTemplate(deps, { name: "Case test" });
  const result = await save(deps, { templateId: created.templateId.toUpperCase(), name: "Case test renamed" });
  assert.deepEqual(result, {
    templateId: created.templateId,
    name: "Case test renamed",
    created: false,
  });
  const stored = await getReportTemplate(admin, BRAND, created.templateId, deps);
  assert.equal(stored.name, "Case test renamed");
});

test("refuses a create at the 10-template cap but still updates", async () => {
  const { deps } = harness();
  const first = await seedTemplate(deps, { name: "Template 0" });
  for (let index = 1; index < REPORT_TEMPLATE_MAX_PER_WORKSPACE; index += 1) {
    await seedTemplate(deps, { name: `Template ${index}` });
  }
  await refusal(
    save(deps, { name: "One too many" }),
    409,
    "template_limit",
    "This workspace has 10 report templates, the limit. Delete one from the Templates page."
  );
  const updated = await save(deps, { templateId: first.templateId, name: "Template 0 renamed" });
  assert.equal(updated.created, false);
});

test("refuses an empty name, description and instructions with the actionable lines", async () => {
  const { deps } = harness();
  await refusal(save(deps, { name: "   " }), 400, "template_name_required", "Give the template a name.");
  await refusal(
    save(deps, { description: "   " }),
    400,
    "template_description_required",
    "Add a one-line description saying when to use this template. It is what the assistant reads to decide."
  );
  await refusal(
    save(deps, { instructions: "   " }),
    400,
    "template_instructions_required",
    "Add instructions: the audience, the sections in order, the tone, and the sign-off."
  );
});

test("refuses over-long values with the exact copy", async () => {
  const { deps } = harness();
  await refusal(
    save(deps, { name: "n".repeat(81) }),
    400,
    "template_name_too_long",
    "Name is 81 characters; the limit is 80. Shorten it and save again."
  );
  await refusal(
    save(deps, { description: "d".repeat(201) }),
    400,
    "template_description_too_long",
    "Description is 201 characters; the limit is 200. It is one line saying when to use the template — move the detail into the instructions."
  );
  await refusal(
    save(deps, { instructions: "i".repeat(3_001) }),
    400,
    "template_instructions_too_long",
    "Instructions are 3,001 characters; the limit is 3,000. A template is a brief, not the report — say the audience, the sections in order, the tone and the sign-off, and cut the rest."
  );
});

test("validates in order: name, description, instructions, then the id", async () => {
  const { deps } = harness();
  await refusal(
    save(deps, { name: "", description: "d".repeat(201), instructions: "i".repeat(3_001), templateId: randomUUID() }),
    400,
    "template_name_required",
    "Give the template a name."
  );
  await refusal(
    save(deps, { description: "", instructions: "i".repeat(3_001), templateId: randomUUID() }),
    400,
    "template_description_required",
    "Add a one-line description saying when to use this template. It is what the assistant reads to decide."
  );
});

test("deleting a template leaves reports intact and their templateId in place", async () => {
  const { reports, deps } = harness();
  const template = await seedTemplate(deps);
  const id = randomUUID();
  const html = "<!doctype html><html><body><p>Report</p></body></html>";
  await (reports as MemoryReportStore).insertReport({
    id,
    brandKey: BRAND,
    title: "Report from a template",
    summary: "Verdict.",
    html,
    skill: null,
    skillVersion: null,
    templateId: template.templateId,
    sessionId: null,
    createdBy: "app",
    createdByUserId: "user-1",
    sizeBytes: Buffer.byteLength(html, "utf8"),
    sanitizerVersion: 1,
  });

  await deleteReportTemplate(admin, BRAND, template.templateId, deps);

  const stored = await (reports as MemoryReportStore).getReport(BRAND, id);
  assert.ok(stored, "the report survives");
  assert.equal(stored.templateId, template.templateId);
  await refusal(
    deleteReportTemplate(admin, BRAND, template.templateId, deps),
    404,
    "template_not_found",
    `No report template ${template.templateId} in this workspace. Call list_report_templates to see what exists.`
  );
});
