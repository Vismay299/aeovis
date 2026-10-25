// Test cases ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/project-context/services/ProjectContextService.test.ts
// Adapted for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../http/appError.ts";
import type { ProjectContextUpdate } from "../../shared/project-context.ts";
import { resolveContextUpdates } from "./contextUpdateOps.ts";

const empty = () => ({ customKeys: new Set<string>(), domains: new Set<string>(), urls: new Set<string>(), ownHost: "example.com" });

test("typed sections trim prose and empty content deletes the section", () => {
  assert.deepEqual(resolveContextUpdates([
    { section: "business_overview", content: "  What we sell  " },
    { section: "current_goal", content: " \n " },
  ], empty()), [
    { kind: "upsert_section", key: "business_overview", title: null, content: "What we sell" },
    { kind: "delete_section", key: "current_goal" },
  ]);
});

test("an empty custom section clears the saved custom row", () => {
  const current = empty();
  current.customKeys.add("custom:launch-plan");
  assert.deepEqual(resolveContextUpdates([{ customSection: "launch-plan", content: "  " }], current), [
    { kind: "delete_section", key: "custom:launch-plan" },
  ]);
});

test("a section over 4,000 characters reports the rejected update index", () => {
  assert.throws(
    () => resolveContextUpdates([{ section: "positioning", content: "x".repeat(4001) }], empty()),
    (error: unknown) => error instanceof AppError && error.code === "context_invalid" &&
      error.message === "updates[0] was rejected (nothing in this batch was applied): Sections are capped at 4,000 characters. Summarize instead of pasting." &&
      error.details?.index === 0,
  );
});

test("custom sections create, edit, delete and count earlier operations", () => {
  const current = empty();
  current.customKeys = new Set(Array.from({ length: 20 }, (_, index) => `custom:section-${index}`));
  const edits = resolveContextUpdates([
    { customSection: "section-0", content: " Revised ", title: "New title" },
    { deleteCustomSection: "section-1" },
    { customSection: "new-section", content: "New" },
  ], current);
  assert.deepEqual(edits, [
    { kind: "upsert_section", key: "custom:section-0", title: "New title", content: "Revised" },
    { kind: "delete_section", key: "custom:section-1" },
    { kind: "upsert_section", key: "custom:new-section", title: null, content: "New" },
  ]);
  assert.throws(
    () => resolveContextUpdates([{ customSection: "twenty-first", content: "New" }], current),
    (error: unknown) => error instanceof AppError && error.code === "context_invalid" && error.details?.index === 0 &&
      error.message.endsWith("A workspace can hold 20 custom sections. Delete one first."),
  );
});

test("competitor inputs normalize and duplicates within an operation keep the last row", () => {
  const resolved = resolveContextUpdates([{
    addCompetitors: [
      { domain: "https://www.Acme.com/pricing", name: "Old" },
      { domain: "acme.com", name: "Latest", notes: "Relevant" },
    ],
  }], empty());
  assert.deepEqual(resolved, [{
    kind: "upsert_competitors",
    rows: [{ domain: "acme.com", name: "Latest", notes: "Relevant", source: "manual", source_url: null }],
  }]);
});

test("own-domain competitor is refused and errors identify the rejected operation", () => {
  assert.throws(
    () => resolveContextUpdates([{ addCompetitors: [{ domain: "www.example.com" }] }], empty()),
    (error: unknown) => error instanceof AppError && error.code === "context_invalid" && error.details?.index === 0 &&
      error.message === "updates[0] was rejected (nothing in this batch was applied): Your own website cannot be a competitor.",
  );
});

test("removal operations normalize competitor domains and key-page URLs", () => {
  assert.deepEqual(resolveContextUpdates([
    { removeCompetitors: ["https://www.Example.com/"] },
    { removeKeyPages: ["http://WWW.Example.com/pricing#faq"] },
  ], empty()), [
    { kind: "delete_competitors", domains: ["example.com"] },
    { kind: "delete_key_pages", urls: ["https://example.com/pricing"] },
  ]);
});

test("competitor cap counts prior operations and allows updating an existing row", () => {
  const current = empty();
  current.domains = new Set(Array.from({ length: 100 }, (_, index) => `competitor-${index}.example`));
  assert.equal(resolveContextUpdates([{ addCompetitors: [{ domain: "competitor-0.example", name: "Updated" }] }], current)[0].kind,
    "upsert_competitors");
  assert.throws(
    () => resolveContextUpdates([
      { addCompetitors: [{ domain: "new.example" }] },
      { addCompetitors: [{ domain: "another.example" }] },
    ], { ...current, domains: new Set(Array.from({ length: 99 }, (_, index) => `competitor-${index}.example`)) }),
    (error: unknown) => error instanceof AppError && error.code === "context_invalid" && error.details?.index === 1 &&
      error.message.endsWith("A workspace can track 100 competitors. Remove some first."),
  );
});

test("key pages normalize, dedupe, preserve omitted role, and count prior operations", () => {
  const resolved = resolveContextUpdates([{
    addKeyPages: [
      { url: "http://www.example.com/a?b=1#c", role: "money", topic: "Old" },
      { url: "https://example.com/a?b=1", topic: "Latest" },
    ],
  }], empty());
  assert.deepEqual(resolved, [{
    kind: "upsert_key_pages",
    rows: [{ url: "https://example.com/a?b=1", role: null, topic: "Latest", notes: null }],
  }]);

  const current = empty();
  current.urls = new Set(Array.from({ length: 100 }, (_, index) => `https://page-${index}.example`));
  assert.equal(resolveContextUpdates([{ addKeyPages: [{ url: "https://page-0.example", role: "money" }] }], current)[0].kind,
    "upsert_key_pages");

  current.urls = new Set(Array.from({ length: 99 }, (_, index) => `https://page-${index}.example`));
  assert.throws(
    () => resolveContextUpdates([
      { addKeyPages: [{ url: "new.example" }] },
      { addKeyPages: [{ url: "another.example" }] },
    ], current),
    (error: unknown) => error instanceof AppError && error.code === "context_invalid" && error.details?.index === 1 &&
      error.message.endsWith("A workspace can hold 100 key pages. This is a shortlist, not a page inventory."),
  );
});

test("a later rejected update prevents a resolved batch from being returned", () => {
  assert.throws(
    () => resolveContextUpdates([
      { section: "current_goal", content: "Grow signups" },
      { addCompetitors: [{ domain: "acme.com" }] },
      { section: "positioning", content: "x".repeat(4001) },
    ], empty()),
    (error: unknown) => error instanceof AppError && error.code === "context_invalid" && error.details?.index === 2 &&
      error.message.startsWith("updates[2] was rejected (nothing in this batch was applied)"),
  );
});

test("removals update the evolving cap state for later operations", () => {
  const current = empty();
  current.domains = new Set(Array.from({ length: 100 }, (_, index) => `competitor-${index}.example`));
  const resolved = resolveContextUpdates([
    { removeCompetitors: ["competitor-0.example"] },
    { addCompetitors: [{ domain: "new.example" }] },
  ], current);
  assert.deepEqual(resolved.map((operation) => operation.kind), ["delete_competitors", "upsert_competitors"]);
});

test("research operations default kind to note and normalize their research key", () => {
  const updates: ProjectContextUpdate[] = [
    { appendResearchLog: { summary: "  A summary  ", researchKey: " ＯＦＦＣＵＬＴ\t IN " } },
    { appendResearchLog: { summary: "Questions", kind: "questions.setup" } },
    { removeResearchLog: ["row-id"] },
  ];
  assert.deepEqual(resolveContextUpdates(updates, empty()), [
    {
      kind: "append_research_log",
      summary: "A summary",
      research_kind: "note",
      research_key: "offcult in",
      spend_usd: null,
      job_id: null,
    },
    {
      kind: "append_research_log",
      summary: "Questions",
      research_kind: "questions.setup",
      research_key: null,
      spend_usd: null,
      job_id: null,
    },
    { kind: "delete_research_log", ids: ["row-id"] },
  ]);
});
