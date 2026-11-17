import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryExploreStore } from "./memoryStore.ts";
import { createExploreStore, type ExploreObservationRow, type ExploreRunRow, type SeedExploreRow } from "./store.ts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const BRAND_A = "brand-a.example";
const BRAND_B = "brand-b.example";
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const PROMPT_HASH = "a".repeat(64);

function run(id: string, brandKey = BRAND_A, createdAt = new Date(NOW).toISOString()): ExploreRunRow {
  return {
    id,
    brand_key: brandKey,
    created_by: "user-1",
    job_id: null,
    prompt: "Best running shoes",
    prompt_hash: PROMPT_HASH,
    models: ["chatgpt"],
    web_search: true,
    country: "IN",
    highlight_brand: null,
    status: "queued",
    plan: [],
    quote: {},
    approved_max_usd: 1,
    hold_id: null,
    question_id: null,
    created_at: createdAt,
    finished_at: null,
  };
}

function observation(patch: Partial<ExploreObservationRow> & Pick<ExploreObservationRow, "id">): ExploreObservationRow {
  return {
    job_id: null,
    purpose: "explore",
    engine: "chatgpt",
    query: "Best running shoes",
    context: {
      explore_run_id: RUN_A,
      prompt_hash: PROMPT_HASH,
      route: "dataforseo",
      model_name: "gpt-5",
      web_search: true,
      country: "IN",
    },
    config_version: "cfg-1",
    circuit_key: "circuit-1",
    state: "answered",
    attempt_count: 1,
    next_attempt_at: new Date(NOW).toISOString(),
    deadline_at: new Date(NOW + 60_000).toISOString(),
    lease_token: null,
    lease_until: null,
    reason: null,
    result: { answer: true },
    observed_at: new Date(NOW - 60_000).toISOString(),
    total_cost: 0.03,
    unknown_cost_calls: 0,
    created_at: new Date(NOW - 60_000).toISOString(),
    brand_key: BRAND_A,
    ...patch,
    id: patch.id,
  };
}

function seed(patch: Partial<SeedExploreRow> & Pick<SeedExploreRow, "id"> = { id: "obs-seed" }): SeedExploreRow {
  return {
    purpose: "explore",
    job_id: null,
    engine: "chatgpt",
    query: "Best running shoes",
    context: { explore_run_id: RUN_A, prompt_hash: PROMPT_HASH },
    config_version: "cfg-1",
    circuit_key: "circuit-1",
    deadline_at: new Date(NOW + 60_000).toISOString(),
    brand_key: BRAND_A,
    ...patch,
    id: patch.id,
  };
}

test("run CRUD stays workspace-scoped and pages newest-first", async () => {
  const store = createMemoryExploreStore({ now: () => NOW });
  const older = run(RUN_A, BRAND_A, new Date(NOW - 3_000).toISOString());
  const newer = run(RUN_B, BRAND_A, new Date(NOW - 1_000).toISOString());
  store.seedRun(older);
  store.seedRun(newer);
  store.seedRun(run("33333333-3333-4333-8333-333333333333", BRAND_B));

  assert.equal(await store.getRun(BRAND_B, RUN_A), null);
  const page = await store.listRuns(BRAND_A, { limit: 1 });
  assert.deepEqual(page.runs.map((row) => row.id), [RUN_B]);
  assert.equal(page.nextCursor, newer.created_at);
  const next = await store.listRuns(BRAND_A, { limit: 1, cursor: page.nextCursor! });
  assert.deepEqual(next.runs.map((row) => row.id), [RUN_A]);
  assert.equal(next.nextCursor, null);

  const updated = await store.updateRun(BRAND_A, RUN_A, { status: "completed", finished_at: new Date(NOW).toISOString() });
  assert.equal(updated?.status, "completed");
  assert.equal(await store.updateRun(BRAND_B, RUN_A, { status: "failed" }), null);
  assert.equal(await store.deleteRun(BRAND_B, RUN_A), false);
  assert.equal(await store.deleteRun(BRAND_A, RUN_A), true);
  assert.equal(await store.getRun(BRAND_A, RUN_A), null);
});

test("createRun stores and returns the generated timestamp", async () => {
  const store = createMemoryExploreStore({ now: () => NOW });
  const created = await store.createRun({ ...run("44444444-4444-4444-8444-444444444444"), created_at: undefined });
  assert.equal(created.created_at, new Date(NOW).toISOString());
  assert.equal((await store.getRun(BRAND_A, created.id))?.id, created.id);
  await assert.rejects(() => store.createRun(run(created.id)), /explore_run_duplicate/);
});

test("seedExplore is idempotent for an identical identity and rejects identity changes", async () => {
  const store = createMemoryExploreStore({ now: () => NOW });
  const row = seed();
  await store.seedExplore([row]);
  await store.seedExplore([row]);
  assert.equal(store.observations.size, 1);
  assert.equal(store.observations.get(row.id)?.state, "pending");

  await assert.rejects(
    () => store.seedExplore([seed({ ...row, query: "Changed query" })]),
    /immutable observation identity mismatch/,
  );
  await assert.rejects(
    () => store.seedExplore([{ ...row, purpose: "scan" } as unknown as SeedExploreRow]),
    /explore rows only/,
  );
});

test("run observations are restricted by workspace and run id", async () => {
  const store = createMemoryExploreStore({
    observations: [
      observation({ id: "a1" }),
      observation({ id: "a2", created_at: new Date(NOW).toISOString(), context: { ...observation({ id: "a2" }).context, explore_run_id: RUN_B } }),
      observation({ id: "b1", brand_key: BRAND_B }),
      observation({ id: "scan1", purpose: "scan" }),
    ],
  });

  const rows = await store.listRunObservations(BRAND_A, RUN_A);
  assert.deepEqual(rows.map((row) => row.id), ["a1"]);
});

test("reuse matches the full workspace/model/prompt/search/country/route key and returns newest", async () => {
  const store = createMemoryExploreStore({ now: () => NOW });
  const base = observation({ id: "old", observed_at: new Date(NOW - 3_000).toISOString() });
  const newest = observation({ id: "new", observed_at: new Date(NOW - 1_000).toISOString(), context: { ...base.context, explore_run_id: RUN_B } });
  store.seedObservation(base);
  store.seedObservation(newest);
  store.seedObservation(observation({ id: "other-brand", brand_key: BRAND_B }));
  store.seedObservation(observation({ id: "other-prompt", context: { ...base.context, prompt_hash: "b".repeat(64) } }));
  store.seedObservation(observation({ id: "other-search", context: { ...base.context, web_search: false } }));
  store.seedObservation(observation({ id: "other-country", context: { ...base.context, country: "US" } }));
  store.seedObservation(observation({ id: "other-route", context: { ...base.context, route: "openrouter" } }));
  store.seedObservation(observation({ id: "failed", state: "failed" }));
  store.seedObservation(observation({ id: "expired", observed_at: new Date(NOW - 8 * 86_400_000).toISOString() }));

  const result = await store.findReusable({
    brandKey: BRAND_A,
    promptHash: PROMPT_HASH,
    routes: [
      { model: "chatgpt", route: "dataforseo", modelName: "gpt-5" },
      { model: "gemini", route: null, modelName: null },
    ],
    webSearch: true,
    country: "IN",
    days: 7,
    now: NOW,
  });
  assert.deepEqual([...result.entries()], [["chatgpt", {
    observationId: "new",
    runId: RUN_B,
    observedAt: new Date(NOW - 1_000).toISOString(),
    configVersion: "cfg-1",
  }]]);
});

test("reuse with no country matches rows where context.country is absent", async () => {
  const row = observation({ id: "null-country", context: { ...observation({ id: "x" }).context, country: undefined } });
  delete row.context.country;
  const store = createMemoryExploreStore({ now: () => NOW, observations: [row] });
  const result = await store.findReusable({
    brandKey: BRAND_A,
    promptHash: PROMPT_HASH,
    routes: [{ model: "chatgpt", route: "dataforseo", modelName: "gpt-5" }],
    webSearch: true,
    country: null,
    days: 7,
    now: NOW,
  });
  assert.equal(result.get("chatgpt")?.observationId, "null-country");
});

test("SQL adapter sends idempotent seed RPC and filters read paths by workspace", async () => {
  const calls: Array<Record<string, unknown>> = [];
  class Query {
    readonly table: string;
    readonly result: unknown;
    constructor(table: string, result: unknown) {
      this.table = table;
      this.result = result;
    }
    action = "select";
    filters: unknown[][] = [];
    orders: unknown[][] = [];
    selectValue: string | null = null;
    limitValue: number | null = null;
    select(value: string) { this.selectValue = value; return this; }
    insert(value: unknown) { this.action = "insert"; calls.push({ table: this.table, action: this.action, value }); return this; }
    update(value: unknown) { this.action = "update"; calls.push({ table: this.table, action: this.action, value }); return this; }
    delete() { this.action = "delete"; calls.push({ table: this.table, action: this.action }); return this; }
    eq(...values: unknown[]) { this.filters.push(["eq", ...values]); return this; }
    gt(...values: unknown[]) { this.filters.push(["gt", ...values]); return this; }
    lt(...values: unknown[]) { this.filters.push(["lt", ...values]); return this; }
    or(...values: unknown[]) { this.filters.push(["or", ...values]); return this; }
    order(...values: unknown[]) { this.orders.push(values); return this; }
    limit(value: number) { this.limitValue = value; return this; }
    single() { return this; }
    maybeSingle() { return this; }
    then(resolve?: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      calls.push({ table: this.table, action: this.action, select: this.selectValue, filters: this.filters, orders: this.orders, limit: this.limitValue });
      return Promise.resolve({ data: this.result, error: null }).then(resolve, reject);
    }
  }
  const admin = {
    from(table: string) {
      const result = table === "explore_runs" ? run(RUN_A) : [observation({ id: "obs" })];
      return new Query(table, result);
    },
    rpc(name: string, args: unknown) {
      calls.push({ rpc: name, args });
      return Promise.resolve({ data: null, error: null });
    },
  };
  const store = createExploreStore(admin as never);

  await store.seedExplore([seed()]);
  assert.deepEqual(calls[0], { rpc: "seed_explore_observations", args: { p_rows: [seed()] } });
  await store.getRun(BRAND_A, RUN_A);
  assert.ok(calls.at(-1)?.filters && JSON.stringify(calls.at(-1)?.filters).includes('"brand_key","brand-a.example"'));
  await store.listRunObservations(BRAND_A, RUN_A);
  const observationQuery = calls.at(-1)!;
  assert.equal(observationQuery.table, "probe_observations");
  assert.ok(JSON.stringify(observationQuery.filters).includes('"brand_key","brand-a.example"'));
  assert.ok(JSON.stringify(observationQuery.filters).includes('"context->>explore_run_id"'));
  await store.findReusable({
    brandKey: BRAND_A,
    promptHash: PROMPT_HASH,
    routes: [{ model: "chatgpt", route: "dataforseo", modelName: "gpt-5" }],
    webSearch: true,
    country: null,
    days: 7,
    now: NOW,
  });
  const reuseQuery = calls.at(-1)!;
  assert.equal(reuseQuery.table, "probe_observations");
  assert.ok(JSON.stringify(reuseQuery.filters).includes('"brand_key","brand-a.example"'));
  assert.ok(JSON.stringify(reuseQuery.filters).includes('"context->>prompt_hash"'));
  assert.ok(JSON.stringify(reuseQuery.filters).includes('"context->>route","dataforseo"'));
  assert.ok(JSON.stringify(reuseQuery.filters).includes('"context->>country.is.null,context->>country.eq."'));
});
