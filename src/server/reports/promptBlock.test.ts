import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMemoryStores } from "./memoryStore.ts";
import { buildTemplatesBlock } from "./promptBlock.ts";

const admin = {} as SupabaseClient;
const BRAND = "brand-a";

test("null when reports is off", async () => {
  const { templates } = createMemoryStores();
  const block = await buildTemplatesBlock(admin, BRAND, {
    isFeatureEnabled: async () => false,
    listReportTemplates: async () => ({ templates: [], remaining: 10 }),
  });
  assert.equal(block, null);
  void templates;
});

test("null when there are no templates", async () => {
  const { templates } = createMemoryStores();
  const block = await buildTemplatesBlock(admin, BRAND, {
    isFeatureEnabled: async () => true,
    listReportTemplates: async () => ({ templates: [], remaining: 10 }),
  });
  assert.equal(block, null);
  void templates;
});

test("lists the workspace templates in the exact block format", async () => {
  const { templates } = createMemoryStores();
  await templates.insertTemplate({
    id: "11111111-1111-4111-8111-111111111111",
    brandKey: BRAND,
    name: "Monthly check-in",
    description: "The monthly update.",
    instructions: "Audience: lead.",
    createdBy: "app",
    createdByUserId: "user-1",
  });
  const block = await buildTemplatesBlock(admin, BRAND, {
    isFeatureEnabled: async () => true,
    listReportTemplates: async (_a, _b, deps) => {
      const { listReportTemplates } = await import("./templateService.ts");
      return listReportTemplates(_a, _b, deps ?? { store: templates });
    },
  });
  assert.equal(
    block,
    "Report templates are the user's briefs for reports. Use one only when the user names it or asks for the kind of report it describes; pass its id to save_report as templateId.\n" +
      "<report_templates>\n" +
      "- Monthly check-in (id 11111111-1111-4111-8111-111111111111): The monthly update.\n" +
      "</report_templates>",
  );
});
