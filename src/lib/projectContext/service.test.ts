// Test cases ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/project-context/services/ProjectContextService.test.ts
// Adapted for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectContext } from "../../shared/project-context.ts";
import { createMemoryProjectContextRepository } from "./memoryRepository.ts";
import {
  appendResearch,
  applyContextUpdates,
  findRecentResearch,
  getProjectContext,
  renderProjectContextMarkdown,
  type ProjectContextDeps,
  type WorkspaceBrand,
} from "./service.ts";

const admin = {} as SupabaseClient;
const brand: WorkspaceBrand = {
  brandKey: "offcult.in",
  display_name: "Offcult",
  website: "https://offcult.in",
  website_host: "www.offcult.in",
  aliases: ["Offcult", "offcult"],
};
const fixedNow = () => new Date("2026-10-25T00:30:00.000Z");

function deps(repo = createMemoryProjectContextRepository({ now: fixedNow })): ProjectContextDeps {
  return { repo, now: fixedNow };
}

function researchRow(overrides: Partial<ProjectContextDeps> & Record<string, unknown> = {}) {
  return {
    brandKey: brand.brandKey,
    id: "research-id",
    entryDate: "2026-10-25",
    kind: "platform.selftest",
    researchKey: "offcult.in",
    summary: "Questions researched",
    spendUsd: 0.0841,
    jobId: null,
    createdBy: "system" as const,
    createdByUser: null,
    createdAt: "2026-10-25T00:00:00.000Z",
    ...overrides,
  };
}

test("typed and custom sections split correctly, and missing typed sections remain listed", async () => {
  const injected = deps();
  const context = await applyContextUpdates(
    admin,
    brand,
    [
      { section: "business_overview", content: "  Tees for India  " },
      { customSection: "priority-topics", title: "Priority topics", content: "- Anime" },
    ],
    "user",
    "user-1",
    injected,
  );
  assert.deepEqual(context.sections.map((row) => row.key), ["business_overview"]);
  assert.deepEqual(context.sections[0], {
    key: "business_overview",
    content: "Tees for India",
    updatedAt: "2026-10-25T00:30:00.000Z",
    updatedBy: "user",
    updatedByUser: "user-1",
  });
  assert.deepEqual(context.missingSections, ["current_goal", "positioning", "writing_preferences"]);
  assert.deepEqual(context.customSections.map(({ slug, title, content }) => ({ slug, title, content })), [
    { slug: "priority-topics", title: "Priority topics", content: "- Anime" },
  ]);
  assert.deepEqual(context.brandIdentity, {
    displayName: "Offcult",
    website: "https://offcult.in",
    matchNames: ["Offcult", "offcult"],
  });
});

test("research appends use the UTC day and prune entries older than ninety days", async () => {
  const injected = deps();
  const repo = injected.repo as ReturnType<typeof createMemoryProjectContextRepository>;
  repo.researchLog.push(
    researchRow({ id: "90-day", entryDate: "2026-07-27" }),
    researchRow({ id: "91-day", entryDate: "2026-07-26" }),
  );
  await appendResearch(admin, {
    brandKey: brand.brandKey,
    kind: "platform.selftest",
    researchKey: "OFFCULT.IN",
    summary: "Today’s research",
    spendUsd: 0.1,
    author: "system",
  }, injected);
  assert.equal(repo.researchLog.some((row) => row.id === "91-day"), false);
  assert.equal(repo.researchLog.some((row) => row.id === "90-day"), true);
  const appended = repo.researchLog.find((row) => row.summary === "Today’s research");
  assert.equal(appended?.entryDate, "2026-10-25");
  assert.equal(appended?.researchKey, "offcult.in");
  assert.equal(appended?.spendUsd, 0.1);
});

test("brief import state exposes retryable claims and committed finality", async () => {
  const repo = createMemoryProjectContextRepository({ now: fixedNow });
  assert.deepEqual(await repo.getBriefImportState("brand.example"), { checkedAt: null, imported: false });
  assert.equal(await repo.claimBriefImport("brand.example"), true);
  const claimed = await repo.getBriefImportState("brand.example");
  assert.equal(typeof claimed.checkedAt, "string");
  assert.equal(claimed.imported, false);
  assert.equal(await repo.claimBriefImport("brand.example"), false);
  assert.deepEqual(await repo.getBriefImportState("brand.example"), claimed);
  assert.equal(await repo.releaseBriefImportClaim("brand.example"), true);
  assert.equal(await repo.releaseBriefImportClaim("brand.example"), false);
  assert.deepEqual(await repo.getBriefImportState("brand.example"), { checkedAt: null, imported: false });
  assert.equal(await repo.claimBriefImport("brand.example"), true);
  await repo.markBriefImported("brand.example");
  const imported = await repo.getBriefImportState("brand.example");
  assert.equal(imported.checkedAt, "2026-10-25T00:30:00.001Z");
  assert.equal(imported.imported, true);
  assert.equal(await repo.claimBriefImport("brand.example"), false);
  assert.equal(await repo.releaseBriefImportClaim("brand.example"), false);
  assert.deepEqual(await repo.getBriefImportState("brand.example"), imported);
});

test("reads return the newest twenty research rows and mark the limit for the digest", async () => {
  const injected = deps();
  const repo = injected.repo as ReturnType<typeof createMemoryProjectContextRepository>;
  for (let index = 0; index < 21; index += 1) {
    repo.researchLog.push(researchRow({
      id: `research-${index}`,
      summary: `Research ${index}`,
      createdAt: `2026-10-25T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
  }
  const context = await getProjectContext(admin, brand, injected);
  assert.equal(context.researchLog.length, 20);
  assert.equal(context.researchLog[0].summary, "Research 20");
  assert.equal(context.researchLog[19].summary, "Research 1");
  assert.equal(context.researchLogLimited, true);
  assert.match(renderProjectContextMarkdown(context), /_Older entries within the 90-day window are omitted\._/);
});

test("digest does not mark a research log limited when it has exactly twenty entries", async () => {
  const injected = deps();
  const repo = injected.repo as ReturnType<typeof createMemoryProjectContextRepository>;
  for (let index = 0; index < 20; index += 1) {
    repo.researchLog.push(researchRow({
      id: `limit-${index}`,
      summary: `Limit ${index}`,
      createdAt: `2026-10-25T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
  }
  const context = await getProjectContext(admin, brand, injected);
  assert.equal(context.researchLog.length, 20);
  assert.equal(context.researchLogLimited, false);
  assert.doesNotMatch(renderProjectContextMarkdown(context), /_Older entries within the 90-day window are omitted\._/);
});

test("recent research is found within ninety days and misses a ninety-one-day-old match", async () => {
  const injected = deps();
  const repo = injected.repo as ReturnType<typeof createMemoryProjectContextRepository>;
  repo.researchLog.push(
    researchRow({ id: "within-window", entryDate: "2026-07-27", createdAt: "2026-07-27T12:00:00.000Z" }),
    researchRow({
      id: "outside-window-only-match",
      researchKey: "old-only.example",
      entryDate: "2026-07-26",
      createdAt: "2026-07-26T12:00:00.000Z",
    }),
  );
  const hit = await findRecentResearch(admin, {
    brandKey: brand.brandKey,
    kind: "platform.selftest",
    researchKey: "  OFFCULT.IN  ",
  }, injected);
  assert.equal(hit?.id, "within-window");
  assert.equal(await findRecentResearch(admin, {
    brandKey: brand.brandKey,
    kind: "platform.selftest",
    researchKey: "old-only.example",
  }, injected), null, "a 91-day-old only match misses under the default 90-day window");
  assert.equal(await findRecentResearch(admin, {
    brandKey: brand.brandKey,
    kind: "platform.selftest",
    researchKey: "offcult.in",
    days: 0,
  }, injected), null);
});

test("digest format includes every typed section, custom content, lists, log and missing line", async () => {
  const context: ProjectContext = {
    brandKey: brand.brandKey,
    sections: [{
      key: "business_overview",
      content: "Anime streetwear",
      updatedAt: "2026-10-25T00:00:00.000Z",
      updatedBy: "user",
      updatedByUser: "user-1",
    }],
    missingSections: ["current_goal", "positioning", "writing_preferences"],
    customSections: [{
      slug: "priority-topics",
      title: "Priority topics",
      content: "- Anime",
      updatedAt: "2026-10-25T00:00:00.000Z",
      updatedBy: "user",
      updatedByUser: "user-1",
    }],
    competitors: [{
      id: "competitor-id",
      domain: "bewakoof.com",
      name: "Bewakoof",
      notes: "Streetwear",
      source: "manual",
      sourceUrl: null,
      updatedAt: "2026-10-25T00:00:00.000Z",
      updatedBy: "user",
      updatedByUser: "user-1",
    }],
    keyPages: [{
      id: "page-id",
      url: "https://offcult.in/collections/tees",
      role: "money",
      topic: "oversized tees",
      notes: null,
      updatedAt: "2026-10-25T00:00:00.000Z",
      updatedBy: "user",
      updatedByUser: "user-1",
    }],
    researchLog: [{
      id: "research-id",
      entryDate: "2026-10-25",
      kind: "platform.selftest",
      researchKey: "offcult.in",
      summary: "Website research complete",
      spendUsd: 0.0841,
      createdBy: "system",
    }],
    researchLogLimited: false,
    brandIdentity: { displayName: "Offcult", website: "https://offcult.in", matchNames: ["Offcult", "offcult"] },
  };
  const digest = renderProjectContextMarkdown(context);
  assert.equal(digest, [
    "# Project context",
    "",
    "## Business overview",
    "",
    "Anime streetwear",
    "",
    "## Current goal",
    "",
    "_Empty_",
    "",
    "## Positioning",
    "",
    "_Empty_",
    "",
    "## Writing preferences",
    "",
    "_Empty_",
    "",
    "## Priority topics",
    "",
    "- Anime",
    "",
    "## Competitors",
    "",
    "- bewakoof.com — Bewakoof (Streetwear)",
    "",
    "## Key pages",
    "",
    "- https://offcult.in/collections/tees — money · oversized tees",
    "",
    "## Research log (1 entry)",
    "",
    "- 2026-10-25: Website research complete [id: research-id]",
    "",
    "Missing sections: current_goal, positioning, writing_preferences",
  ].join("\n"));
});
