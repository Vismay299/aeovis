import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HEALTHCARE_CXO_BRIEF } from "../../shared/content/briefs/healthcareCxo.js";
import { briefToOps, isSeededBrief } from "./briefImport.ts";
import { createMemoryProjectContextRepository } from "./memoryRepository.ts";
import { createProjectContextRepository } from "./repository.ts";
import { maybeImportBrandBrief, type WorkspaceBrand } from "./service.ts";

const FIXTURES = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/f07/brand-briefs.json", import.meta.url), "utf8"),
) as {
  brand_key: string;
  generic_preset: Record<string, unknown>;
  generic_preset_with_display_name: Record<string, unknown>;
  edited_offcult: Record<string, unknown>;
};

const BRAND_KEY = FIXTURES.brand_key;
const DISPLAY_NAME = "Offcult";
const fixedNow = () => new Date("2026-10-25T00:30:00.000Z");

const brand: WorkspaceBrand = {
  brandKey: BRAND_KEY,
  display_name: DISPLAY_NAME,
  website: "https://offcult.in",
  website_host: "www.offcult.in",
  aliases: ["Offcult", "offcult"],
};

/** The healthcare preset as `resolveBrief` persists it: the brand key prefixes the one-liner. */
const seededHealthcare = { ...HEALTHCARE_CXO_BRIEF, one_liner: `${BRAND_KEY} — ${HEALTHCARE_CXO_BRIEF.one_liner}` };

// --- seeded detection ------------------------------------------------------

test("isSeededBrief recognises the healthcare preset seeded with the brand-key prefix", () => {
  assert.equal(isSeededBrief(seededHealthcare, BRAND_KEY, DISPLAY_NAME), true);
});

test("isSeededBrief recognises the generic preset keyed by the brand key and by the display name", () => {
  assert.equal(isSeededBrief(FIXTURES.generic_preset, BRAND_KEY, DISPLAY_NAME), true);
  assert.equal(isSeededBrief(FIXTURES.generic_preset_with_display_name, BRAND_KEY, DISPLAY_NAME), true);
  // Without the display name the second preset is only recognisable by its own
  // key set, which is why GAP-04 widened the signature.
  assert.equal(isSeededBrief(FIXTURES.generic_preset_with_display_name, BRAND_KEY), false);
});

test("isSeededBrief refuses an edited healthcare preset", () => {
  assert.equal(isSeededBrief({ ...seededHealthcare, personas: ["Hospital buyer"] }, BRAND_KEY, DISPLAY_NAME), false);
  assert.equal(isSeededBrief({ ...seededHealthcare, one_liner: "A different one-liner" }, BRAND_KEY, DISPLAY_NAME), false);
});

test("isSeededBrief refuses edited briefs: an extra key, changed rules, a foreign one-liner", () => {
  assert.equal(isSeededBrief(FIXTURES.edited_offcult, BRAND_KEY, DISPLAY_NAME), false);
  const extraKey = { ...FIXTURES.generic_preset, vertical: "retail" };
  assert.equal(isSeededBrief(extraKey, BRAND_KEY, DISPLAY_NAME), false, "an extra key means somebody edited it");
  const changedRules = { ...FIXTURES.generic_preset, tone_rules: ["Use clear, factual language."] };
  assert.equal(isSeededBrief(changedRules, BRAND_KEY, DISPLAY_NAME), false);
  const foreignOneLiner = { ...FIXTURES.generic_preset, one_liner: "Someone else" };
  assert.equal(isSeededBrief(foreignOneLiner, BRAND_KEY, DISPLAY_NAME), false);
});

test("isSeededBrief refuses a brief whose website is not a string", () => {
  assert.equal(isSeededBrief({ ...FIXTURES.generic_preset, website: 42 }, BRAND_KEY, DISPLAY_NAME), false);
});

// --- mapping ---------------------------------------------------------------

test("briefToOps maps an edited brief onto insert-only section and list operations", () => {
  const ops = briefToOps(FIXTURES.edited_offcult, "www.offcult.in");

  assert.deepEqual(ops.map((op) => op.kind), [
    "insert_section_if_missing",
    "insert_section_if_missing",
    "insert_section_if_missing",
    "insert_competitors_if_none",
    "upsert_key_pages",
  ]);

  const sections = ops.filter((op) => op.kind === "insert_section_if_missing");
  assert.deepEqual(sections, [
    {
      kind: "insert_section_if_missing",
      key: "business_overview",
      title: null,
      content:
        "Oversized and heavyweight T-shirts with anime graphics, sold online across India.\n\n" +
        "Buyers: 18-30 year old anime fans; Streetwear collectors",
    },
    {
      kind: "insert_section_if_missing",
      key: "writing_preferences",
      title: null,
      content: "- Casual and direct.\n- Never say 'premium quality'.",
    },
    {
      kind: "insert_section_if_missing",
      key: "custom:priority-topics",
      title: "Priority topics",
      content: "- Oversized tees\n- Anime drops",
    },
  ]);
});

test("briefToOps keeps only domain-shaped competitors and drops the workspace's own host", () => {
  const ops = briefToOps({ competitors: ["Bewakoof", "thesouledstore.com", "https://www.offcult.in/"] }, "offcult.in");
  assert.deepEqual(ops, [{
    kind: "insert_competitors_if_none",
    rows: [{ domain: "thesouledstore.com", name: null, notes: null, source: "brief_import", source_url: null }],
  }]);
});

test("briefToOps normalises money-page URLs and keeps the own host as a key page", () => {
  const ops = briefToOps({ money_pages: FIXTURES.edited_offcult.money_pages }, "offcult.in");
  const [keyPages] = ops;
  assert.equal(keyPages.kind, "upsert_key_pages");
  assert.deepEqual(keyPages.kind === "upsert_key_pages" ? keyPages.rows : [], [
    { url: "https://offcult.in/collections/oversized-tees", role: "money", topic: null, notes: null },
    { url: "https://offcult.in/collections/anime-drop", role: "money", topic: null, notes: null },
  ]);
});

test("briefToOps caps money pages at the workspace key-page cap", () => {
  const moneyPages = Array.from({ length: 120 }, (_unused, index) => `offcult.in/pages/${index}`);
  const [op] = briefToOps({ money_pages: moneyPages }, "offcult.in");
  assert.equal(op.kind, "upsert_key_pages");
  assert.equal(op.kind === "upsert_key_pages" ? op.rows.length : 0, 100);
});

test("briefToOps returns no operations for a brief with nothing importable", () => {
  assert.deepEqual(briefToOps({}, "offcult.in"), []);
  assert.deepEqual(briefToOps({ competitors: ["Bewakoof"], money_pages: ["not a url"] }, "offcult.in"), []);
});

test("briefToOps trims an over-long overview to the 4,000-character prose cap", () => {
  const [op] = briefToOps({ one_liner: "x".repeat(5_000) }, "offcult.in");
  assert.equal(op.kind, "insert_section_if_missing");
  assert.equal(op.kind === "insert_section_if_missing" ? op.content.length : 0, 4_000);
});

// --- brief lookup order ----------------------------------------------------

type FakeWorkspace = { brand_key: string; display_name: string; aliases: string[] };

function fakeBriefAdmin(rows: Record<string, Record<string, unknown>>, workspaces: FakeWorkspace[] = []) {
  const asked: string[] = [];
  const admin = {
    from(table: string) {
      if (table === "customer_brands") {
        let matches = workspaces;
        const query = {
          select: () => query,
          eq(column: "brand_key" | "display_name", value: string) {
            matches = matches.filter((row) => row[column] === value);
            return query;
          },
          neq(column: "brand_key", value: string) {
            matches = matches.filter((row) => row[column] !== value);
            return query;
          },
          contains(column: "aliases", values: string[]) {
            matches = matches.filter((row) => values.every((value) => row[column].includes(value)));
            return query;
          },
          async limit(count: number) {
            return { data: matches.slice(0, count).map((row) => ({ brand_key: row.brand_key })), error: null };
          },
        };
        return query;
      }
      assert.equal(table, "brand_briefs");
      let current = "";
      return {
        select(columns: string) {
          assert.equal(columns, "brief");
          return this;
        },
        eq(column: string, value: string) {
          assert.equal(column, "brand");
          current = value;
          asked.push(value);
          return this;
        },
        async maybeSingle() {
          const brief = rows[current];
          return { data: brief ? { brief } : null, error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { admin, asked };
}

test("the repository tries brand_key, then display_name, then each alias, exact and in order", async () => {
  const { admin, asked } = fakeBriefAdmin({ offcult: { one_liner: "Found by alias" } });
  const repo = createProjectContextRepository(admin);

  const brief = await repo.getBrandBrief({ brandKey: "offcult.in", displayName: "Offcult", aliases: ["offcult", "Offcult"] });
  assert.deepEqual(brief, { one_liner: "Found by alias" });
  // "Offcult" is both the display name and the second alias, so it is asked once.
  assert.deepEqual(asked, ["offcult.in", "Offcult", "offcult"]);
});

test("the repository never case-folds or fuzzy-matches a brief lookup", async () => {
  const { admin, asked } = fakeBriefAdmin({ "OFFCULT.IN": { one_liner: "Upper case row" } });
  const repo = createProjectContextRepository(admin);
  assert.equal(await repo.getBrandBrief({ brandKey: "offcult.in", displayName: "offcult", aliases: [] }), null);
  assert.deepEqual(asked, ["offcult.in", "offcult"]);
});

test("a fallback name another workspace owns is never imported across tenants", async () => {
  const { admin, asked } = fakeBriefAdmin(
    { "victim.com": { one_liner: "Victim brief" }, Victim: { one_liner: "Victim legacy brief" } },
    [
      { brand_key: "victim.com", display_name: "Victim", aliases: ["victim-alias"] },
      { brand_key: "attacker.io", display_name: "victim.com", aliases: [] },
    ],
  );
  const repo = createProjectContextRepository(admin);
  // The attacker names itself after the victim's brand key, then its display name.
  assert.equal(await repo.getBrandBrief({ brandKey: "attacker.io", displayName: "victim.com", aliases: [] }), null);
  assert.equal(await repo.getBrandBrief({ brandKey: "attacker.io", displayName: "Victim", aliases: ["victim-alias"] }), null);
  assert.deepEqual(asked, ["attacker.io", "attacker.io"], "only the workspace's own key reaches brand_briefs");
});

test("a workspace's own display name still finds its unclaimed legacy brief", async () => {
  const { admin } = fakeBriefAdmin(
    { Offcult: { one_liner: "Legacy row" } },
    [{ brand_key: "offcult.in", display_name: "Offcult", aliases: ["offcult"] }],
  );
  const repo = createProjectContextRepository(admin);
  assert.deepEqual(
    await repo.getBrandBrief({ brandKey: "offcult.in", displayName: "Offcult", aliases: ["offcult"] }),
    { one_liner: "Legacy row" },
  );
});

test("the memory repository mirrors the same exact-match fallback order", async () => {
  const repo = createMemoryProjectContextRepository({
    brandBriefs: { Offcult: { one_liner: "Display-name row" } },
    now: fixedNow,
  });
  const brief = await repo.getBrandBrief({ brandKey: "offcult.in", displayName: "Offcult", aliases: ["offcult"] });
  assert.deepEqual(brief, { one_liner: "Display-name row" });
  assert.equal(
    await repo.getBrandBrief({ brandKey: "OFFCULT.IN", displayName: "offcult", aliases: [] }),
    null,
    "no case folding, no fuzzy match",
  );
});

// --- maybeImportBrandBrief -------------------------------------------------

test("a non-seeded brief is imported once as system and a second read claims nothing", async () => {
  const repo = createMemoryProjectContextRepository({
    brandBriefs: { [BRAND_KEY]: FIXTURES.edited_offcult },
    now: fixedNow,
  });
  const deps = { repo, now: fixedNow };

  assert.equal(await maybeImportBrandBrief({} as SupabaseClient, brand, deps), true);

  const overview = repo.sections.get(`${BRAND_KEY}\0business_overview`);
  assert.ok(overview, "the overview section is written");
  assert.equal(overview.updatedBy, "system");
  assert.equal(overview.updatedByUser, null);
  assert.equal(repo.competitors.get(`${BRAND_KEY}\0thesouledstore.com`)?.source, "brief_import");
  assert.equal(repo.keyPages.get(`${BRAND_KEY}\0https://offcult.in/collections/oversized-tees`)?.role, "money");
  assert.equal(repo.briefImported.has(BRAND_KEY), true);

  const written = repo.sections.size;
  assert.equal(await maybeImportBrandBrief({} as SupabaseClient, brand, deps), false, "a completed read imports nothing");
  assert.equal(repo.sections.size, written);
});

test("a missing brief and a still-seeded brief are successful no-ops that leave the checked stamp", async () => {
  for (const briefs of [{}, { [BRAND_KEY]: seededHealthcare }, { [BRAND_KEY]: FIXTURES.generic_preset }]) {
    const repo = createMemoryProjectContextRepository({ brandBriefs: briefs, now: fixedNow });
    const deps = { repo, now: fixedNow };
    assert.equal(await maybeImportBrandBrief({} as SupabaseClient, brand, deps), false);
    assert.equal(repo.sections.size, 0, "nothing is imported");
    assert.equal(typeof repo.briefChecked.get(BRAND_KEY), "string", "the stamp stays, so nothing retries forever");
    assert.equal(repo.briefImported.has(BRAND_KEY), false);
  }
});

test("a committed import blocks any later claim, even with an imported brief on disk", async () => {
  const repo = createMemoryProjectContextRepository({
    brandBriefs: { [BRAND_KEY]: FIXTURES.edited_offcult },
    now: fixedNow,
  });
  repo.briefImported.add(BRAND_KEY);
  assert.equal(await maybeImportBrandBrief({} as SupabaseClient, brand, { repo, now: fixedNow }), false);
  assert.equal(repo.sections.size, 0);
  assert.equal(repo.briefChecked.has(BRAND_KEY), false, "a committed import is never claimed");
});

test("a brief with nothing importable is still marked imported and never sends zero operations", async () => {
  const repo = createMemoryProjectContextRepository({
    brandBriefs: { [BRAND_KEY]: { one_liner: "", competitors: ["Bewakoof"] } },
    now: fixedNow,
  });
  const applied: number[] = [];
  const spy = {
    ...repo,
    async applyOps(...args: Parameters<typeof repo.applyOps>) {
      applied.push(args[1].length);
      return repo.applyOps(...args);
    },
  };
  assert.equal(await maybeImportBrandBrief({} as SupabaseClient, brand, { repo: spy, now: fixedNow }), true);
  assert.deepEqual(applied, [], "the 1–60-operation RPC is never called with zero operations");
  assert.equal(repo.briefImported.has(BRAND_KEY), true);
});

test("a failure after claiming releases the claim, logs the brand key only, and a later read retries", async () => {
  const repo = createMemoryProjectContextRepository({
    brandBriefs: { [BRAND_KEY]: FIXTURES.edited_offcult },
    now: fixedNow,
  });
  let failNext = true;
  const flaky = {
    ...repo,
    async applyOps(...args: Parameters<typeof repo.applyOps>) {
      if (failNext) {
        failNext = false;
        throw new Error(`${FIXTURES.edited_offcult.one_liner ?? ""} could not be written`);
      }
      return repo.applyOps(...args);
    },
  };

  const logged: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
  try {
    assert.equal(await maybeImportBrandBrief({} as SupabaseClient, brand, { repo: flaky, now: fixedNow }), false);
  } finally {
    console.error = original;
  }

  assert.deepEqual(logged, [`[project-context] brief import failed ${BRAND_KEY}`]);
  assert.ok(
    !logged.join("\n").includes(String(FIXTURES.edited_offcult.one_liner)),
    "the failure log must never contain brief content",
  );
  assert.equal(repo.briefChecked.has(BRAND_KEY), false, "the claim is released so a later read retries");
  assert.equal(repo.sections.size, 0);

  assert.equal(await maybeImportBrandBrief({} as SupabaseClient, brand, { repo: flaky, now: fixedNow }), true);
  assert.equal(repo.briefImported.has(BRAND_KEY), true);
});

test("a failed claim release is logged with the brand key and the import still returns false", async () => {
  const repo = createMemoryProjectContextRepository({
    brandBriefs: { [BRAND_KEY]: FIXTURES.edited_offcult },
    now: fixedNow,
  });
  const broken = {
    ...repo,
    async getBrandBrief() {
      throw new Error("lookup exploded");
    },
    async releaseBriefImportClaim() {
      throw new Error("release exploded");
    },
  };

  const logged: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
  try {
    assert.equal(await maybeImportBrandBrief({} as SupabaseClient, brand, { repo: broken, now: fixedNow }), false);
  } finally {
    console.error = original;
  }

  assert.equal(logged[0], `[project-context] brief import failed ${BRAND_KEY}`);
  assert.match(logged[1] ?? "", new RegExp(`^\\[project-context\\] brief import claim release failed ${BRAND_KEY}`));
  assert.equal(repo.briefChecked.has(BRAND_KEY), true, "the stamp survives a failed release, as §11 risk 7 says");
});
