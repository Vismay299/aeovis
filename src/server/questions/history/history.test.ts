import test from "node:test";
import assert from "node:assert/strict";
import { getQuestionHistory } from "./history.ts";

const BRAND_KEY = "offcult.in";
const QUESTION_ID = "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182";

function makeAdmin(options: {
  question?: Record<string, unknown> | null;
  children?: Array<Record<string, unknown>>;
  replacement?: Record<string, unknown> | null;
  links?: Array<Record<string, unknown>>;
  observations?: Map<string, Record<string, unknown>>;
  legacies?: Map<string, Record<string, unknown>>;
  scheduled?: Set<string>;
  failTable?: string | null;
}) {
  const question = "question" in options ? options.question : {
    id: QUESTION_ID,
    brand_key: BRAND_KEY,
    text: "best oversized t-shirt brands in india",
    topic: "Oversized tees",
    status: "active",
    branded: false,
    origin: "ai_setup",
    replaced_by: null,
  };
  const links = options.links ?? [];
  const observations = options.observations ?? new Map();
  const legacies = options.legacies ?? new Map();
  const scheduled = options.scheduled ?? new Set<string>();
  const calls: Array<{ table: string; op: string }> = [];

  function queryBuilder(table: string) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, value: unknown) => {
        filters.push((row) => String(row[col]) === String(value));
        return builder;
      },
      gte: (col: string, value: string) => {
        filters.push((row) => String(row[col]) >= value);
        return builder;
      },
      lte: (col: string, value: string) => {
        filters.push((row) => String(row[col]) <= value);
        return builder;
      },
      in: (col: string, values: unknown[]) => {
        const set = new Set((values as unknown[]).map(String));
        filters.push((row) => set.has(String(row[col])));
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        calls.push({ table, op: "maybeSingle" });
        if (options.failTable === table) throw new Error(`db boom ${table}`);
        if (table === "workspace_questions") {
          const pool: Array<Record<string, unknown>> = [];
          if (question) pool.push(question);
          for (const child of options.children ?? []) pool.push(child);
          if (options.replacement) pool.push(options.replacement as Record<string, unknown>);
          const matched = pool.filter((row) => filters.every((fn) => fn(row as Record<string, unknown>)));
          return { data: matched[0] ?? null, error: null };
        }
        if (table === "question_answer_links") {
          const matched = links.filter((row) => filters.every((fn) => fn(row)));
          return { data: matched[0] ?? null, error: null };
        }
        if (table === "probe_observations") {
          return { data: null, error: null };
        }
        if (table === "prompt_results") {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        try {
          calls.push({ table, op: "list" });
          if (options.failTable === table) throw new Error(`db boom ${table}`);
          if (table === "workspace_questions") {
            const pool: Array<Record<string, unknown>> = [];
            if (question) pool.push(question);
            for (const child of options.children ?? []) pool.push(child);
            if (options.replacement) pool.push(options.replacement);
            const matched = pool.filter((row) => filters.every((fn) => fn(row)));
            return Promise.resolve({ data: matched, error: null }).then(resolve as never, reject as never);
          }
          if (table === "question_answer_links") {
            const matched = links.filter((row) => filters.every((fn) => fn(row)));
            return Promise.resolve({ data: matched, error: null }).then(resolve as never, reject as never);
          }
          if (table === "probe_observations") {
            const all = [...observations.values()];
            const matched = all.filter((row) => filters.every((fn) => fn(row)));
            return Promise.resolve({ data: matched, error: null }).then(resolve as never, reject as never);
          }
          if (table === "prompt_results") {
            const all = [...legacies.values()];
            const matched = all.filter((row) => filters.every((fn) => fn(row)));
            return Promise.resolve({ data: matched, error: null }).then(resolve as never, reject as never);
          }
          if (table === "measurement_windows") {
            const all = [...scheduled].map((job_id) => ({ job_id }));
            const matched = all.filter((row) => filters.every((fn) => fn(row as unknown as Record<string, unknown>)));
            return Promise.resolve({ data: matched, error: null }).then(resolve as never, reject as never);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve as never, reject as never);
        } catch (error) {
          return Promise.reject(error).then(resolve as never, reject as never);
        }
      },
    };
    return builder;
  }

  const admin = {
    from: (table: string) => queryBuilder(table),
  };
  return { admin: admin as never, calls };
}

function makeWorkspace(admin: never) {
  return {
    user: { id: "user-1", email: "owner@example.com" },
    brandKey: BRAND_KEY,
    brand: {
      brandKey: BRAND_KEY,
      role: "member" as const,
      display_name: "Offcult",
      website: "https://offcult.in",
      website_host: "offcult.in",
      aliases: ["Offcult"],
      is_active: true,
    },
    role: "member" as const,
    admin: admin as never,
  };
}

test("history maps executions, summary and coverage without answer text", async () => {
  const observations = new Map<string, Record<string, unknown>>([
    [
      "obs-1",
      {
        id: "obs-1",
        purpose: "scan",
        state: "answered",
        reason: null,
        answer_present: true,
        error: null,
        mention_state: "observed",
        own_mentioned: true,
        own_cited: false,
        brands: [
          { name: "Offcult", is_self: true, mentioned: true },
          { name: "Bewakoof", is_self: false, mentioned: true },
        ],
        competitors_cited: ["Bewakoof"],
        method: "model_api",
      },
    ],
  ]);
  const { admin } = makeAdmin({
    links: [
      {
        id: "6a1f0000-0000-4000-8000-000000000001",
        question_id: QUESTION_ID,
        brand_key: BRAND_KEY,
        source: "scan",
        observation_id: "obs-1",
        prompt_result_id: null,
        scan_job_id: "job-1",
        scan_id: "9e8d0000-0000-4000-8000-000000000001",
        explore_run_id: null,
        engine: "chatgpt",
        asked_text: "best oversized t-shirt brands in india",
        collected_at: "2026-10-20T10:12:04.000Z",
      },
    ],
    observations,
  });
  const ws = makeWorkspace(admin);
  const result = await getQuestionHistory(ws, QUESTION_ID, {}, { linkBeforeRead: async () => null });
  assert.equal(result.executions.length, 1);
  assert.equal((result.executions[0] as Record<string, unknown>).status, "answered");
  assert.equal((result.coverage as Record<string, unknown>).answered, 1);
  assert.ok(!(JSON.stringify(result.executions).includes("Popular oversized")));
  const summary = result.summary as Array<Record<string, unknown>>;
  assert.equal(summary[0].isSelf, true);
  assert.equal((result as { truncated: boolean }).truncated, false);
  assert.equal((result as { latestScanId: string | null }).latestScanId, "9e8d0000-0000-4000-8000-000000000001");
});

test("history 404s for another workspace question and validates range", async () => {
  const { admin } = makeAdmin({ question: null });
  const ws = makeWorkspace(admin);
  await assert.rejects(
    () => getQuestionHistory(ws, QUESTION_ID, {}, { linkBeforeRead: async () => null }),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "question_not_found",
  );
  await assert.rejects(
    () =>
      getQuestionHistory(
        ws,
        QUESTION_ID,
        { from: "2026-10-21T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" },
        { linkBeforeRead: async () => null },
      ),
    (error: { status?: number; code?: string }) => error.status === 400 && error.code === "invalid_range",
  );
});

test("history never logs question or answer text", async () => {
  const secretQuestion = "best oversized t-shirt brands in india secret-word";
  const { admin } = makeAdmin({
    question: {
      id: QUESTION_ID,
      brand_key: BRAND_KEY,
      text: secretQuestion,
      topic: "General",
      status: "active",
      branded: false,
      origin: "manual",
      replaced_by: null,
    },
    links: [],
  });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const ws = makeWorkspace(admin);
    const tracked: Array<Record<string, unknown>> = [];
    await getQuestionHistory(
      ws,
      QUESTION_ID,
      {},
      { linkBeforeRead: async () => null, trackView: (props) => void tracked.push(props as unknown as Record<string, unknown>) },
    );
    assert.equal(tracked.length, 1);
    assert.ok(!JSON.stringify(tracked[0]).includes(secretQuestion));
  } finally {
    console.error = original;
  }
  for (const line of logged) {
    assert.ok(!line.includes(secretQuestion), "question text must never be logged");
  }
});

test("history maps valid_no_aio to no_answer and failed with error to failed", async () => {
  const observations = new Map<string, Record<string, unknown>>([
    [
      "obs-aio",
      {
        id: "obs-aio",
        purpose: "scan",
        state: "valid_no_aio",
        reason: null,
        answer_present: false,
        error: null,
        mention_state: null,
        own_mentioned: null,
        own_cited: null,
        brands: [],
        competitors_cited: [],
        method: "google_serp",
      },
    ],
    [
      "obs-fail",
      {
        id: "obs-fail",
        purpose: "scan",
        state: "answered",
        reason: null,
        answer_present: true,
        error: "provider exploded",
        mention_state: null,
        own_mentioned: null,
        own_cited: null,
        brands: [],
        competitors_cited: [],
        method: "model_api",
      },
    ],
  ]);
  const { admin } = makeAdmin({
    links: [
      {
        id: "7b2e0000-0000-4000-8000-000000000002",
        question_id: QUESTION_ID,
        brand_key: BRAND_KEY,
        source: "scan",
        observation_id: "obs-aio",
        prompt_result_id: null,
        scan_job_id: null,
        scan_id: null,
        explore_run_id: null,
        engine: "aio",
        asked_text: "best oversized t-shirt brands in india",
        collected_at: "2026-10-20T10:14:41.000Z",
      },
      {
        id: "8c3f0000-0000-4000-8000-000000000003",
        question_id: QUESTION_ID,
        brand_key: BRAND_KEY,
        source: "scan",
        observation_id: "obs-fail",
        prompt_result_id: null,
        scan_job_id: null,
        scan_id: null,
        explore_run_id: null,
        engine: "chatgpt",
        asked_text: "best oversized t-shirt brands in india",
        collected_at: "2026-10-19T09:00:00.000Z",
      },
    ],
    observations,
  });
  const ws = makeWorkspace(admin);
  const result = await getQuestionHistory(ws, QUESTION_ID, {}, { linkBeforeRead: async () => null });
  const byId = new Map((result.executions as Array<Record<string, unknown>>).map((entry) => [entry.answerId, entry]));
  assert.equal(byId.get("7b2e0000-0000-4000-8000-000000000002")?.status, "no_answer");
  assert.equal(byId.get("8c3f0000-0000-4000-8000-000000000003")?.status, "failed");
});

test("history surfaces replacedBy and replaces notices", async () => {
  const replacement = { id: "22222222-2222-4222-8222-222222222222", text: "newer wording here", brand_key: BRAND_KEY };
  const child = { id: "33333333-3333-4333-8333-333333333333", text: "older wording here", brand_key: BRAND_KEY, replaced_by: QUESTION_ID };
  const { admin } = makeAdmin({
    question: {
      id: QUESTION_ID,
      brand_key: BRAND_KEY,
      text: "best oversized t-shirt brands in india",
      topic: "General",
      status: "active",
      branded: false,
      origin: "manual",
      replaced_by: replacement.id,
    },
    replacement,
    children: [child],
    links: [],
  });
  const ws = makeWorkspace(admin);
  const result = await getQuestionHistory(ws, QUESTION_ID, {}, { linkBeforeRead: async () => null });
  const question = result.question as Record<string, unknown>;
  assert.deepEqual(question.replacedBy, { id: replacement.id, text: replacement.text });
  assert.deepEqual(question.replaces, [{ id: child.id, text: child.text }]);
});
