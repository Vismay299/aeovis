import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import { createMemoryStores } from "./memoryStore.ts";
import { startReportGeneration } from "./generate.ts";
import { setReportEventTracker } from "./telemetry.ts";

const admin = {} as SupabaseClient;
const BRAND = "brand-a";

function ws(over: Record<string, unknown> = {}) {
  return {
    user: { id: "user-1", email: "owner@acme.example" },
    brandKey: BRAND,
    brand: { brandKey: BRAND, display_name: "Acme", website: "https://acme.example", website_host: "acme.example", aliases: [], is_active: true, role: "owner" },
    role: "owner",
    admin,
    ...over,
  } as never;
}

test("requires reports, report_generate and assistant", async () => {
  const { templates } = createMemoryStores();
  for (const off of ["reports", "report_generate", "assistant"]) {
    await assert.rejects(
      startReportGeneration(ws(), { templateId: "00000000-0000-4000-8000-000000000001" }, {
        isFeatureEnabled: async (name) => name !== off,
        getReportTemplate: async () => ({ id: "t", name: "N", description: "d", instructions: "i" }) as never,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.status, 404);
        assert.equal(error.code, "feature_unavailable");
        return true;
      },
    );
  }
});

test("a missing template is 404 template_not_found", async () => {
  const { reports, templates } = createMemoryStores();
  await assert.rejects(
    startReportGeneration(ws(), { templateId: "00000000-0000-4000-8000-000000000001" }, {
      isFeatureEnabled: async () => true,
      getReportTemplate: async () => {
        const { getReportTemplate } = await import("./templateService.ts");
        return getReportTemplate(admin, BRAND, "00000000-0000-4000-8000-000000000001", { store: templates });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "template_not_found");
      return true;
    },
  );
  void reports;
});

test("creates one titled session with the generate_report kickoff and returns the path", async () => {
  const { templates } = createMemoryStores();
  const templateId = "11111111-1111-4111-8111-111111111111";
  await templates.insertTemplate({
    id: templateId,
    brandKey: BRAND,
    name: "Monthly client check-in",
    description: "The monthly update.",
    instructions: "Audience: the lead.",
    createdBy: "app",
    createdByUserId: "user-1",
  });
  const calls: Array<{ kind: string; args: unknown }> = [];
  const events: string[] = [];
  setReportEventTracker((name) => { events.push(name); });
  try {
    const result = await startReportGeneration(ws(), { templateId }, {
      isFeatureEnabled: async () => true,
      getReportTemplate: async (a, b, id, deps) => {
        const { getReportTemplate } = await import("./templateService.ts");
        return getReportTemplate(a, b, id, deps ?? { store: templates });
      },
      createSession: (async (_a: unknown, input: { brandKey: string; userId: string; kickoff?: Record<string, unknown>; title?: string }) => {
        calls.push({ kind: "create", args: input });
        return { id: "sess-1", brandKey: input.brandKey, userId: input.userId, title: input.title ?? "New chat", summary: null, compactedThroughSeq: null, kickoff: input.kickoff ?? null, archivedAt: null, createdAt: "2026-11-17T12:00:00.000Z", updatedAt: "2026-11-17T12:00:00.000Z" };
      }) as never,
    });
    assert.deepEqual(result, { sessionId: "sess-1", path: "/portal/assistant?s=sess-1" });
    assert.equal(calls.length, 1, "one write: the session is born titled, there is no rename to fail");
    assert.deepEqual(calls[0]?.args, {
      brandKey: BRAND,
      userId: "user-1",
      kickoff: { kind: "generate_report", templateId },
      title: "Report: Monthly client check-in",
    });
    assert.deepEqual(events, ["report:generate_start"]);
  } finally {
    setReportEventTracker(null);
  }
});

test("a failed session create propagates and nothing else is written", async () => {
  const { templates } = createMemoryStores();
  const templateId = "33333333-3333-4333-8333-333333333333";
  await templates.insertTemplate({
    id: templateId, brandKey: BRAND, name: "Weekly", description: "d", instructions: "i", createdBy: "app", createdByUserId: "user-1",
  });
  let creates = 0;
  await assert.rejects(
    startReportGeneration(ws(), { templateId }, {
      isFeatureEnabled: async () => true,
      getReportTemplate: async (a, b, id, deps) => {
        const { getReportTemplate } = await import("./templateService.ts");
        return getReportTemplate(a, b, id, deps ?? { store: templates });
      },
      createSession: (async () => {
        creates += 1;
        throw new Error("insert failed");
      }) as never,
    }),
    /insert failed/,
  );
  assert.equal(creates, 1);
});

test("a long template name is cut to 80 characters, never through a surrogate pair", async () => {
  const { templates } = createMemoryStores();
  const templateId = "22222222-2222-4222-8222-222222222222";
  // "Report: " is 8 characters, so the cut falls inside the 72nd and 73rd characters.
  const name = "N".repeat(71) + "\uD83D\uDE80\uD83D\uDE80";
  await templates.insertTemplate({
    id: templateId, brandKey: BRAND, name, description: "d", instructions: "i", createdBy: "app", createdByUserId: "user-1",
  });
  let title = "";
  await startReportGeneration(ws(), { templateId }, {
    isFeatureEnabled: async () => true,
    getReportTemplate: async (a, b, id, deps) => {
      const { getReportTemplate } = await import("./templateService.ts");
      return getReportTemplate(a, b, id, deps ?? { store: templates });
    },
    createSession: (async (_a: unknown, input: { title?: string }) => {
      title = input.title ?? "";
      return { id: "sess-2", brandKey: BRAND, userId: "user-1", title, summary: null, compactedThroughSeq: null, kickoff: null, archivedAt: null, createdAt: "", updatedAt: "" };
    }) as never,
  });
  assert.ok(title.startsWith("Report: "));
  assert.ok(Array.from(title).length <= 80, "the database allows 80 characters");
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(title), false, "no lone surrogate");
});
