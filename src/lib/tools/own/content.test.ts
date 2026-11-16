import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../http/appError.ts";
import {
  createListContentItemsTool,
  createStartContentDraftTool,
} from "./content.ts";
import type { ToolHandlerContext } from "../types.ts";

type Row = Record<string, any>;

function fakeAdmin(tables: Record<string, Row[]>) {
  const admin = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const state = { limit: 0, order: null as null | { column: string; ascending: boolean } };
      const query: any = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          state.order = { column, ascending: options?.ascending !== false };
          return query;
        },
        limit(n: number) {
          state.limit = n;
          return query;
        },
        then(resolve: (value: any) => unknown, reject: (error: unknown) => unknown) {
          let rows = (tables[table] ?? []).filter((candidate) =>
            filters.every(([key, value]) => candidate[key] === value),
          );
          if (state.order) {
            const { column, ascending } = state.order;
            rows = [...rows].sort((a, b) =>
              ascending ? String(a[column]).localeCompare(String(b[column])) : String(b[column]).localeCompare(String(a[column])),
            );
          }
          if (state.limit) rows = rows.slice(0, state.limit);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  } as any;

  const context = {
    admin,
    brand: {
      brandKey: "brand-a",
      role: "owner",
      display_name: "Acme",
      website: "https://acme.test",
      website_host: "acme.test",
      aliases: [],
      is_active: true,
    },
    userId: "user-a",
    user: { id: "user-a", email: "owner@acme.test" },
    role: "owner",
    requestId: "test",
    source: "test",
  } as ToolHandlerContext;

  return { context };
}

test("start_content_draft refuses a generating topic before quoting or creating a job", async () => {
  const { context } = fakeAdmin({});
  const order: string[] = [];
  let quotes = 0;
  let creates = 0;
  let keepAlives = 0;

  const tool = createStartContentDraftTool({
    requireApprovedPrice: (async () => {
      quotes += 1;
      return { quote: { totalUsd: 0.15 }, approvedMaxUsd: 0.5, source: "dialog" };
    }) as any,
    hasActiveContentJobForBrand: (async (brand: string, opts: any) => {
      order.push("active");
      assert.equal(brand, "brand-a");
      assert.deepEqual(opts, { playbook: "geo_article", query: "running shoes" });
      return true;
    }) as any,
    createContentJob: (async () => {
      creates += 1;
      return { id: "job-1", status: "pending" };
    }) as any,
    keepAlive: (() => {
      keepAlives += 1;
    }) as any,
  });

  await assert.rejects(
    () => tool.handler(context, { topic: "running shoes", maxUsd: 0.5 }),
    (error) => error instanceof AppError && error.code === "content_in_progress",
  );

  assert.deepEqual(order, ["active"]);
  assert.equal(quotes, 0, "an already-generating topic must not be quoted");
  assert.equal(creates, 0);
  assert.equal(keepAlives, 0);
});

test("start_content_draft creates the job and hands it to keepAlive on success", async () => {
  const { context } = fakeAdmin({});
  const order: string[] = [];
  let createdJob: any;
  let kept: { work?: () => Promise<unknown> | void; label?: string } = {};
  let started: string | null = null;

  const tool = createStartContentDraftTool({
    requireApprovedPrice: (async () => {
      order.push("quote");
      return {
        quote: { totalUsd: 0.15 },
        approvedMaxUsd: 0.5,
        source: "dialog",
      };
    }) as any,
    hasActiveContentJobForBrand: (async () => {
      order.push("active");
      return false;
    }) as any,
    createContentJob: (async (job: any) => {
      createdJob = job;
      return { id: "job-42", status: "pending" };
    }) as any,
    startContentJob: (async (jobId: string) => {
      started = jobId;
    }) as any,
    keepAlive: ((work: () => Promise<unknown> | void, opts?: { label?: string }) => {
      kept = { work, label: opts?.label };
    }) as any,
  });

  const output = (await tool.handler(context, {
    topic: "running shoes",
    brief: "Focus on trail runners",
    maxUsd: 0.5,
  })) as any;

  assert.deepEqual(output, { jobId: "job-42", status: "pending" });
  assert.deepEqual(order, ["active", "quote"]);
  assert.deepEqual(createdJob, {
    brand: "brand-a",
    playbook: "geo_article",
    input: {
      query: "running shoes",
      brief: "Focus on trail runners",
      brand_name: "Acme",
      url: "https://acme.test",
    },
  });
  assert.equal(kept.label, "assistant-content");
  assert.equal(started, null, "the worker starts only when keepAlive runs the work");
  await kept.work?.();
  assert.equal(started, "job-42");
});

test("list_content_items maps rows for this brand newest first", async () => {
  const { context } = fakeAdmin({
    content_items: [
      { id: "item-1", brand: "brand-a", title: "Older", status: "published", updated_at: "2026-11-01T09:00:00.000Z" },
      { id: "item-2", brand: "brand-a", title: "Newer", status: "draft", updated_at: "2026-11-10T09:00:00.000Z" },
      { id: "item-3", brand: "brand-b", title: "Other", status: "draft", updated_at: "2026-11-12T09:00:00.000Z" },
    ],
  });
  const tool = createListContentItemsTool({});

  const output = (await tool.handler(context, { limit: 20 })) as any;

  assert.deepEqual(output.items, [
    { id: "item-2", title: "Newer", status: "draft", updatedAt: "2026-11-10T09:00:00.000Z" },
    { id: "item-1", title: "Older", status: "published", updatedAt: "2026-11-01T09:00:00.000Z" },
  ]);
});
