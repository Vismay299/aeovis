import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * R3.2.4's rule, applied here because this file imports the content worker:
 * clearing the shared client's credentials before the module graph is evaluated
 * means `src/lib/db.js` builds no client, so nothing in this suite can reach a
 * database. The imports below are dynamic for that reason.
 */
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { PROJECT_MEMORY_BRIEF_MAX_CHARS, withProjectMemory, defaultProjectMemoryMarkdown } = await import(
  "./contentOverlay.ts"
);
const { resolveBrief } = await import("../content/contentWorker.js");
const { getProjectContextByKey, renderProjectContextMarkdown } = await import("./service.ts");
const { createMemoryProjectContextRepository } = await import("./memoryRepository.ts");

const fixedNow = () => new Date("2026-10-25T00:30:00.000Z");
const DIGEST = [
  "# Project context",
  "",
  "## Business overview",
  "",
  "Oversized tees",
  "",
  "Missing sections: current_goal, positioning, writing_preferences",
].join("\n");

const BRAND_KEY = "workspace-a";
const storedBrief = { one_liner: "Tile manufacturer", tone_rules: ["Concise"] };
const requestInput = { brand_name: "Italica", url: "https://italicatiles.com/" };

// --- withProjectMemory -----------------------------------------------------

test("withProjectMemory returns a new object carrying the digest and never mutates its input", () => {
  const brief = { one_liner: "Tile manufacturer" };
  const withMemory = withProjectMemory(brief, DIGEST);
  assert.notEqual(withMemory, brief);
  assert.deepEqual(brief, { one_liner: "Tile manufacturer" });
  assert.deepEqual(withMemory, { one_liner: "Tile manufacturer", project_memory: DIGEST });
});

test("withProjectMemory caps the digest at 12,000 characters", () => {
  assert.equal(PROJECT_MEMORY_BRIEF_MAX_CHARS, 12_000);
  const markdown = "x".repeat(20_000);
  assert.equal(String(withProjectMemory({}, markdown).project_memory).length, PROJECT_MEMORY_BRIEF_MAX_CHARS);
});

// --- resolveBrief integration ---------------------------------------------

test("flag on: the pipeline's brief carries project_memory and the upsert does not", async () => {
  let persisted: Record<string, unknown> | null = null;
  const brief = await resolveBrief(BRAND_KEY, requestInput, {
    getBrandBrief: async () => null,
    upsertBrandBrief: async (_brand: string, value: Record<string, unknown>) => {
      persisted = value;
    },
    isFeatureEnabled: async () => true,
    getProjectMemoryMarkdown: async () => DIGEST,
  });

  assert.equal(brief.project_memory, DIGEST);
  assert.equal(brief.one_liner, "Italica");
  assert.ok(persisted !== null, "the seeded preset is still persisted");
  const saved = persisted as Record<string, unknown>;
  assert.equal(saved.project_memory, undefined, "memory is never written onto the brand brief");
});

test("flag on: the stored-brief path receives the digest without mutating the stored object", async () => {
  const stored = { ...storedBrief };
  const brief = await resolveBrief(BRAND_KEY, {}, {
    getBrandBrief: async () => ({ brief: stored }),
    isFeatureEnabled: async () => true,
    getProjectMemoryMarkdown: async () => DIGEST,
  });

  assert.notEqual(brief, stored);
  assert.equal(brief.project_memory, DIGEST);
  assert.equal(brief.one_liner, "Tile manufacturer");
  assert.equal(Object.hasOwn(stored, "project_memory"), false);
});

test("flag off: no digest, no read, and the returned brief is exactly today's", async () => {
  const today = await resolveBrief(BRAND_KEY, requestInput, {
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => undefined,
  });

  let reads = 0;
  const flagOff = await resolveBrief(BRAND_KEY, requestInput, {
    getBrandBrief: async () => null,
    upsertBrandBrief: async () => undefined,
    isFeatureEnabled: async () => false,
    getProjectMemoryMarkdown: async () => {
      reads += 1;
      return DIGEST;
    },
  });

  assert.equal(reads, 0, "a flag that is off must not read memory at all");
  assert.deepEqual(flagOff, today);
  assert.equal(Object.hasOwn(flagOff, "project_memory"), false);
});

test("an overlay error is logged without content and downgrades to the plain brief", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...parts: unknown[]) => {
    warnings.push(parts.map(String).join(" "));
  };
  try {
    const brief = await resolveBrief(BRAND_KEY, {}, {
      getBrandBrief: async () => ({ brief: storedBrief }),
      isFeatureEnabled: async () => true,
      getProjectMemoryMarkdown: async () => {
        throw new Error("memory store unavailable");
      },
    });
    assert.deepEqual(brief, storedBrief);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[content-worker\] project memory unavailable/);
  assert.match(warnings[0], /memory store unavailable/);
});

test("the default digest source is used, and its failure (no service client) still returns the plain brief", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...parts: unknown[]) => {
    warnings.push(parts.map(String).join(" "));
  };
  try {
    const brief = await resolveBrief(BRAND_KEY, {}, {
      getBrandBrief: async () => ({ brief: storedBrief }),
      isFeatureEnabled: async () => true,
    });
    assert.deepEqual(brief, storedBrief);
  } finally {
    console.warn = original;
  }
  assert.match(warnings[0] ?? "", /^\[content-worker\] project memory unavailable/);
});

// --- the default markdown source ------------------------------------------

function brandRowAdmin(
  row: Record<string, unknown> | null,
  error: { message: string } | null = null,
): SupabaseClient {
  return {
    from(table: string) {
      assert.equal(table, "customer_brands");
      let column = "";
      return {
        select(columns: string) {
          assert.equal(columns, "brand_key,display_name,website,website_host,aliases");
          return this;
        },
        eq(name: string, value: string) {
          assert.equal(name, "brand_key");
          column = value;
          return this;
        },
        async maybeSingle() {
          assert.equal(column, BRAND_KEY);
          return { data: row, error };
        },
      };
    },
  } as unknown as SupabaseClient;
}

test("getProjectContextByKey reads the brand row and renders the same context as a full brand", async () => {
  const repo = createMemoryProjectContextRepository({ now: fixedNow });
  const admin = brandRowAdmin({
    brand_key: BRAND_KEY,
    display_name: "Italica Tiles",
    website: "https://italicatiles.com",
    website_host: "www.italicatiles.com",
    aliases: ["Italica"],
  });

  const context = await getProjectContextByKey(admin, BRAND_KEY, { repo, now: fixedNow });
  assert.equal(context.brandKey, BRAND_KEY);
  assert.deepEqual(context.brandIdentity, {
    displayName: "Italica Tiles",
    website: "https://italicatiles.com",
    matchNames: ["Italica Tiles", "Italica"],
  });
  assert.deepEqual(context.missingSections, [
    "business_overview",
    "current_goal",
    "positioning",
    "writing_preferences",
  ]);
  assert.match(renderProjectContextMarkdown(context), /^# Project context\n/);
});

test("getProjectContextByKey answers 404 workspace_not_found for a missing row", async () => {
  await assert.rejects(
    () => getProjectContextByKey(brandRowAdmin(null), BRAND_KEY, { repo: createMemoryProjectContextRepository({ now: fixedNow }), now: fixedNow }),
    (err: unknown) => {
      const error = err as { status?: number; code?: string; message?: string };
      assert.equal(error.status, 404);
      assert.equal(error.code, "workspace_not_found");
      assert.equal(error.message, "Workspace not found.");
      return true;
    },
  );
});

test("getProjectContextByKey answers 503 context_unavailable when the brand read fails", async () => {
  await assert.rejects(
    () => getProjectContextByKey(
      brandRowAdmin(null, { message: "permission denied" }),
      BRAND_KEY,
      { repo: createMemoryProjectContextRepository({ now: fixedNow }), now: fixedNow },
    ),
    (err: unknown) => {
      const error = err as { status?: number; code?: string };
      assert.equal(error.status, 503);
      assert.equal(error.code, "context_unavailable");
      return true;
    },
  );
});

test("defaultProjectMemoryMarkdown refuses when no service client is configured", async () => {
  await assert.rejects(
    () => defaultProjectMemoryMarkdown(BRAND_KEY),
    (err: unknown) => {
      const error = err as { status?: number; code?: string };
      assert.equal(error.status, 503);
      assert.equal(error.code, "storage_unavailable");
      return true;
    },
  );
});
