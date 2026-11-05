/**
 * F03 §6.2 — the live cost of a scan, read from the attempt ledger.
 *
 * The fake admin answers the four reads the service makes, so these cases are
 * about the mapping: the same mapping SQL `f03_upsert_attempt_rows` writes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnswerCosts, getScanCost } from "./scanCost.ts";
import type { ScanCost } from "./types.ts";

type Row = Record<string, unknown>;

type Query = {
  select: () => Query;
  eq: (column: string, value: unknown) => Query;
  in: (column: string, values: unknown[]) => Query;
  order: () => Query;
  limit: () => Query;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  single: () => Promise<{ data: unknown; error: null }>;
  then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
};

/** The admin the service sees: four tables, no network, no database. */
function fakeAdmin(tables: Record<string, Row[]>): SupabaseClient {
  const admin = {
    from(table: string) {
      let rows = (tables[table] ?? []).slice();
      const query: Query = {
        select: () => query,
        eq: (column, value) => {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        in: (column, values) => {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        single: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return query;
    },
  };
  return admin as unknown as SupabaseClient;
}

const BRAND = "workspace-a";
const JOB = "job-1";

function tables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    scan_jobs: [{ id: JOB, brand_key: BRAND, status: "complete" }],
    probe_observations: [
      { id: "obs-chatgpt", job_id: JOB, purpose: "scan", engine: "chatgpt", state: "answered" },
      { id: "obs-gemini", job_id: JOB, purpose: "scan", engine: "gemini", state: "answered" },
    ],
    probe_attempts: [
      {
        observation_id: "obs-chatgpt",
        attempt_no: 1,
        reserved_usd: 0.2,
        charged_usd: 0.04,
        cost_state: "measured",
        dispatch_state: "recorded",
      },
      {
        observation_id: "obs-chatgpt",
        attempt_no: 2,
        reserved_usd: 0.2,
        charged_usd: 0,
        cost_state: "confirmed_not_dispatched",
        dispatch_state: "recorded",
      },
      {
        observation_id: "obs-gemini",
        attempt_no: 1,
        reserved_usd: 0.2,
        charged_usd: 0.03,
        cost_state: "measured",
        dispatch_state: "recorded",
      },
      {
        observation_id: "obs-gemini",
        attempt_no: 2,
        reserved_usd: 0.2,
        charged_usd: 0.05,
        cost_state: "reconciliation_conflict",
        dispatch_state: "recorded",
      },
    ],
    spend_holds: [],
    ...overrides,
  };
}

function near(actual: number, expected: number, what: string) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: ${actual} is not ${expected}`
  );
}

test("a scan's cost is the sum of its attempts, per engine", async () => {
  const cost = await getScanCost(fakeAdmin(tables()), JOB, BRAND);

  assert.equal(cost.state, "final");
  assert.equal(cost.jobId, JOB);
  assert.equal(cost.answers, 2);
  // The confirmed_not_dispatched attempt is not an attempt at all.
  assert.equal(cost.attempts, 3);
  near(cost.knownUsd, 0.07, "knownUsd");
  assert.equal(cost.unknownAttempts, 1);
  near(cost.reservedUnknownUsd, 0.2, "reservedUnknownUsd");
  near(cost.totalAccountedUsd, 0.27, "totalAccountedUsd");

  const chatgpt = cost.byEngine.find((row) => row.engine === "chatgpt");
  const gemini = cost.byEngine.find((row) => row.engine === "gemini");
  assert.ok(chatgpt && gemini);
  assert.equal(chatgpt.label, "ChatGPT");
  assert.equal(chatgpt.answers, 1);
  assert.equal(chatgpt.attempts, 1);
  near(chatgpt.knownUsd, 0.04, "chatgpt knownUsd");
  assert.equal(chatgpt.unknownAttempts, 0);
  near(chatgpt.perAnswerUsd ?? 0, 0.04, "chatgpt perAnswerUsd");

  assert.equal(gemini.label, "Gemini");
  // The disputed attempt is an attempt too: it was made and it cost a
  // reservation, so it is counted and it is unknown.
  assert.equal(gemini.attempts, 2);
  near(gemini.knownUsd, 0.03, "gemini knownUsd");
  // The disputed attempt is unknown, so the engine has no per-answer figure.
  assert.equal(gemini.unknownAttempts, 1);
  assert.equal(gemini.perAnswerUsd, null);
});

test("an unknown attempt makes the per-answer figure null", async () => {
  const cost = await getScanCost(fakeAdmin(tables()), JOB, BRAND);
  assert.equal(cost.perAnswerUsd, null, "a partial cost is not a per-answer cost");
});

test("a scan with no unknown attempt has a per-answer cost", async () => {
  const clean = tables({
    probe_attempts: [
      {
        observation_id: "obs-chatgpt",
        attempt_no: 1,
        reserved_usd: 0.2,
        charged_usd: 0.04,
        cost_state: "measured",
        dispatch_state: "recorded",
      },
      {
        observation_id: "obs-gemini",
        attempt_no: 1,
        reserved_usd: 0.2,
        charged_usd: 0.02,
        cost_state: "measured",
        dispatch_state: "recorded",
      },
    ],
  });
  const cost = await getScanCost(fakeAdmin(clean), JOB, BRAND);
  near(cost.knownUsd, 0.06, "knownUsd");
  assert.equal(cost.unknownAttempts, 0);
  near(cost.perAnswerUsd ?? 0, 0.03, "perAnswerUsd");
  near(cost.totalAccountedUsd, 0.06, "totalAccountedUsd");
});

test("a reconciliation conflict is unknown even when the provider charged", async () => {
  const conflict = tables({
    probe_attempts: [
      {
        observation_id: "obs-chatgpt",
        attempt_no: 1,
        reserved_usd: 0.2,
        charged_usd: 0.05,
        cost_state: "reconciliation_conflict",
        dispatch_state: "recorded",
      },
    ],
    probe_observations: [{ id: "obs-chatgpt", job_id: JOB, purpose: "scan", engine: "chatgpt", state: "answered" }],
  });
  const cost = await getScanCost(fakeAdmin(conflict), JOB, BRAND);
  near(cost.knownUsd, 0, "a disputed cost is not a known one");
  assert.equal(cost.unknownAttempts, 1);
  near(cost.reservedUnknownUsd, 0.2, "reservedUnknownUsd");
  assert.equal(cost.perAnswerUsd, null);
});

test("a confirmed-not-dispatched attempt costs nothing and is not an attempt", async () => {
  const only = tables({
    probe_attempts: [
      {
        observation_id: "obs-chatgpt",
        attempt_no: 1,
        reserved_usd: 0.2,
        charged_usd: 0,
        cost_state: "confirmed_not_dispatched",
        dispatch_state: "recorded",
      },
    ],
    probe_observations: [{ id: "obs-chatgpt", job_id: JOB, purpose: "scan", engine: "chatgpt", state: "answered" }],
  });
  const cost = await getScanCost(fakeAdmin(only), JOB, BRAND);
  assert.equal(cost.attempts, 0);
  assert.equal(cost.unknownAttempts, 0);
  near(cost.knownUsd, 0, "knownUsd");
  near(cost.totalAccountedUsd, 0, "totalAccountedUsd");
  assert.deepEqual(cost.byEngine, []);
});

test("a legacy scan with no job has no cost at all, never zero", async () => {
  const cost = await getScanCost(fakeAdmin(tables()), null, BRAND);
  assert.equal(cost.state, "unavailable");
  assert.equal(cost.jobId, null);
  assert.equal(cost.answers, 0);
  assert.equal(cost.perAnswerUsd, null);
  assert.equal(cost.heldUsd, null);
});

test("a job with no observations is unavailable", async () => {
  const empty = tables({ probe_observations: [], probe_attempts: [] });
  const cost = await getScanCost(fakeAdmin(empty), JOB, BRAND);
  assert.equal(cost.state, "unavailable");
});

test("another workspace's job is a 404, never another workspace's numbers", async () => {
  await assert.rejects(
    () => getScanCost(fakeAdmin(tables()), JOB, "workspace-b"),
    (err: unknown) => {
      assert.equal((err as { status?: number }).status, 404);
      assert.equal((err as { code?: string }).code, "scan_not_found");
      return true;
    }
  );
});

test("the open hold's estimate is the amount reserved for a running scan", async () => {
  const running = tables({
    scan_jobs: [{ id: JOB, brand_key: BRAND, status: "running" }],
    spend_holds: [
      {
        brand_key: BRAND,
        subject_kind: "scan_job",
        subject_id: JOB,
        status: "held",
        estimate_usd: 1.5,
      },
    ],
  });
  const cost = await getScanCost(fakeAdmin(running), JOB, BRAND);
  assert.equal(cost.state, "running");
  near(cost.heldUsd ?? 0, 1.5, "heldUsd");
});

test("a running job's intent attempts are not counted, a terminal job's are", async () => {
  const intent = {
    observation_id: "obs-chatgpt",
    attempt_no: 3,
    reserved_usd: 0.2,
    charged_usd: 0.05,
    cost_state: "measured",
    dispatch_state: "intent",
  };
  const running = tables({
    scan_jobs: [{ id: JOB, brand_key: BRAND, status: "running" }],
    probe_attempts: [intent],
    probe_observations: [{ id: "obs-chatgpt", job_id: JOB, purpose: "scan", engine: "chatgpt", state: "answered" }],
  });
  const runningCost = await getScanCost(fakeAdmin(running), JOB, BRAND);
  assert.equal(runningCost.attempts, 0, "an intent is not a cost yet");

  const terminal = tables({
    scan_jobs: [{ id: JOB, brand_key: BRAND, status: "complete" }],
    probe_attempts: [intent],
    probe_observations: [{ id: "obs-chatgpt", job_id: JOB, purpose: "scan", engine: "chatgpt", state: "answered" }],
  });
  const terminalCost = await getScanCost(fakeAdmin(terminal), JOB, BRAND);
  assert.equal(terminalCost.attempts, 1, "a terminal job's intent is a cost");
  near(terminalCost.knownUsd, 0.05, "knownUsd");
});

test("the per-answer costs are keyed by the observation the report joins on", async () => {
  const costs = await getAnswerCosts(fakeAdmin(tables()), JOB, BRAND);

  const chatgpt = costs.get("obs-chatgpt");
  const gemini = costs.get("obs-gemini");
  assert.ok(chatgpt && gemini);
  assert.equal(chatgpt.observationId, "obs-chatgpt");
  assert.equal(chatgpt.engine, "chatgpt");
  assert.equal(chatgpt.attempts, 1);
  near(chatgpt.knownUsd, 0.04, "knownUsd");
  assert.equal(chatgpt.usd, 0.04);

  // The disputed attempt leaves the answer without a figure.
  // It is still an attempt: it was made and it cost a reservation.
  assert.equal(gemini.attempts, 2);
  assert.equal(gemini.unknownAttempts, 1);
  near(gemini.reservedUnknownUsd, 0.2, "reservedUnknownUsd");
  assert.equal(gemini.usd, null);
});

/* ── AC-19: the live read and the synced ledger are one number ───────── */

type FixtureAttempt = {
  observation_id: string;
  purpose: string;
  engine: string;
  attempt_no: number;
  dispatch_state: string;
  reserved_usd: number;
  charged_usd: number | null;
  cost_state: string;
  started_at: string;
  finished_at: string;
  result: { cost_source?: string; provenance?: { gateway?: string } } | null;
};

/**
 * The phase's own synthetic attempts — the fixture the database group seeds
 * and the SQL mapping reads, shared with the ledger below.
 */
const FIXTURE_ATTEMPTS: FixtureAttempt[] = JSON.parse(
  readFileSync(
    new URL("../../../tests/fixtures/f03/probe-attempts.json", import.meta.url),
    "utf8"
  )
);

/**
 * The rows SQL `f03_upsert_attempt_rows` wrote for the fixture's attempts:
 * one row per finished attempt, `source_ref = probe_attempt:<observation>:<attempt>`.
 *
 * They are written out rather than derived from the attempts on purpose. AC-19
 * is about TWO paths agreeing — the live read and the ledger — so a ledger
 * derived from the same attempts would only agree with itself.
 */
const SYNCED_LEDGER_ROWS: Row[] = [
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-01",
    source_ref: "probe_attempt:f03-obs-01:1",
    provider: "openrouter",
    endpoint: "probe:chatgpt",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0.004,
    accounted_usd: 0.004,
    cost_source: "provider_reported",
    occurred_at: "2026-10-21T10:00:02.000Z",
    meta: { engine: "chatgpt", attempt_no: 1, cost_state: "measured", reported_source: "gateway" },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-02",
    source_ref: "probe_attempt:f03-obs-02:1",
    provider: "openrouter",
    endpoint: "probe:gemini",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0.0035,
    accounted_usd: 0.0035,
    cost_source: "provider_reported",
    occurred_at: "2026-10-21T10:00:05.000Z",
    meta: { engine: "gemini", attempt_no: 1, cost_state: "measured", reported_source: "gateway" },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-03",
    source_ref: "probe_attempt:f03-obs-03:1",
    provider: "brightdata",
    endpoint: "probe:aio",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0.005,
    accounted_usd: 0.005,
    cost_source: "provider_reported",
    occurred_at: "2026-10-21T10:00:08.000Z",
    meta: { engine: "aio", attempt_no: 1, cost_state: "measured", reported_source: "gateway" },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-04",
    source_ref: "probe_attempt:f03-obs-04:1",
    provider: "openrouter",
    endpoint: "probe:perplexity",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0.04,
    accounted_usd: 0.04,
    cost_source: "provider_reported",
    occurred_at: "2026-10-21T10:00:11.000Z",
    meta: { engine: "perplexity", attempt_no: 1, cost_state: "measured", reported_source: "gateway" },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-05",
    source_ref: "probe_attempt:f03-obs-05:1",
    provider: "openrouter",
    endpoint: "probe:chatgpt",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0.0042,
    accounted_usd: 0.0042,
    cost_source: "provider_reported",
    occurred_at: "2026-10-21T10:00:14.000Z",
    meta: { engine: "chatgpt", attempt_no: 1, cost_state: "measured", reported_source: "gateway" },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-06",
    source_ref: "probe_attempt:f03-obs-06:1",
    provider: "openrouter",
    endpoint: "probe:gemini",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0.0038,
    accounted_usd: 0.0038,
    cost_source: "provider_reported",
    occurred_at: "2026-10-21T10:00:17.000Z",
    meta: { engine: "gemini", attempt_no: 1, cost_state: "measured", reported_source: "gateway" },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-07",
    source_ref: "probe_attempt:f03-obs-07:1",
    provider: "brightdata",
    endpoint: "probe:aio",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0.0048,
    accounted_usd: 0.0048,
    cost_source: "provider_reported",
    occurred_at: "2026-10-21T10:00:20.000Z",
    meta: { engine: "aio", attempt_no: 1, cost_state: "measured", reported_source: "gateway" },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-08",
    source_ref: "probe_attempt:f03-obs-08:1",
    provider: "brightdata",
    endpoint: "probe:aio",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0.0015,
    accounted_usd: 0.0015,
    cost_source: "price_table",
    occurred_at: "2026-10-21T10:00:23.000Z",
    meta: {
      engine: "aio",
      attempt_no: 1,
      cost_state: "measured",
      reported_source: "serp_price_table",
    },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-09",
    source_ref: "probe_attempt:f03-obs-09:1",
    provider: "openrouter",
    endpoint: "probe:chatgpt",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: null,
    accounted_usd: 0.2,
    cost_source: "reservation",
    occurred_at: "2026-10-21T10:00:26.000Z",
    meta: { engine: "chatgpt", attempt_no: 1, cost_state: "unknown_billed", reported_source: null },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-10",
    source_ref: "probe_attempt:f03-obs-10:1",
    provider: "openrouter",
    endpoint: "probe:gemini",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: null,
    accounted_usd: 0.2,
    cost_source: "reservation",
    occurred_at: "2026-10-21T10:00:29.000Z",
    meta: { engine: "gemini", attempt_no: 1, cost_state: "unknown_billed", reported_source: null },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-11",
    source_ref: "probe_attempt:f03-obs-11:1",
    provider: "openrouter",
    endpoint: "probe:perplexity",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0,
    accounted_usd: 0,
    cost_source: "none",
    occurred_at: "2026-10-21T10:00:32.000Z",
    meta: {
      engine: "perplexity",
      attempt_no: 1,
      cost_state: "confirmed_not_dispatched",
      reported_source: null,
    },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-12",
    source_ref: "probe_attempt:f03-obs-12:1",
    provider: "openrouter",
    endpoint: "probe:chatgpt",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: 0.0045,
    accounted_usd: 0.0045,
    cost_source: "provider_reported",
    occurred_at: "2026-10-21T10:00:35.000Z",
    meta: { engine: "chatgpt", attempt_no: 1, cost_state: "measured", reported_source: "gateway" },
  },
  {
    brand_key: BRAND,
    feature: "ai_visibility.scan",
    subject_kind: "scan_job",
    subject_id: JOB,
    answer_ref: "f03-obs-13",
    source_ref: "probe_attempt:f03-obs-13:1",
    provider: "openrouter",
    endpoint: "probe:gemini",
    units: 1,
    estimate_usd: 0.2,
    actual_usd: null,
    accounted_usd: 0.2,
    cost_source: "reservation",
    occurred_at: "2026-10-21T10:00:38.000Z",
    meta: {
      engine: "gemini",
      attempt_no: 1,
      cost_state: "reconciliation_conflict",
      reported_source: "gateway",
    },
  },
];

/** The tables the fixture describes: the job, its observations and attempts. */
function fixtureTables(): Record<string, Row[]> {
  return {
    scan_jobs: [{ id: JOB, brand_key: BRAND, status: "complete" }],
    probe_observations: FIXTURE_ATTEMPTS.map((attempt) => ({
      id: attempt.observation_id,
      job_id: JOB,
      purpose: attempt.purpose,
      engine: attempt.engine,
      state: "answered",
    })),
    probe_attempts: FIXTURE_ATTEMPTS.map((attempt) => ({
      observation_id: attempt.observation_id,
      attempt_no: attempt.attempt_no,
      reserved_usd: attempt.reserved_usd,
      charged_usd: attempt.charged_usd,
      cost_state: attempt.cost_state,
      dispatch_state: attempt.dispatch_state,
    })),
    spend_holds: [],
    spend_ledger: SYNCED_LEDGER_ROWS,
  };
}

/** The ledger rows the sync wrote for one job. */
async function readLedger(admin: SupabaseClient, jobId: string): Promise<Row[]> {
  const result = await admin
    .from("spend_ledger")
    .select("*")
    .eq("subject_kind", "scan_job")
    .eq("subject_id", jobId);
  return (result.data ?? []) as Row[];
}

/** The ledger rows of one job's attempts, and nothing else. */
function attemptLedgerRows(rows: Row[]): Row[] {
  return rows.filter((row) => String(row.source_ref ?? "").startsWith("probe_attempt:"));
}

/**
 * Where the live read and the synced ledger disagree. Empty means the two
 * paths are the same number; AC-19 says a divergence must fail the test.
 */
function ledgerDifferences(cost: ScanCost, rows: Row[]): string[] {
  const differences: string[] = [];
  const attemptRows = attemptLedgerRows(rows);

  const ledgerTotal = attemptRows.reduce((sum, row) => sum + Number(row.accounted_usd ?? 0), 0);
  if (Math.abs(cost.totalAccountedUsd - ledgerTotal) > 1e-9) {
    differences.push(`totalAccountedUsd ${cost.totalAccountedUsd} != ledger ${ledgerTotal}`);
  }

  const ledgerKnown = new Map<string, number>();
  for (const row of attemptRows) {
    const source = String(row.cost_source ?? "");
    if (source !== "provider_reported" && source !== "price_table") continue;
    const engine = String((row.meta as Row | undefined)?.engine ?? "unknown");
    ledgerKnown.set(engine, (ledgerKnown.get(engine) ?? 0) + Number(row.accounted_usd ?? 0));
  }
  for (const bucket of cost.byEngine) {
    const expected = ledgerKnown.get(bucket.engine) ?? 0;
    if (Math.abs(bucket.knownUsd - expected) > 1e-9) {
      differences.push(`byEngine[${bucket.engine}].knownUsd ${bucket.knownUsd} != ledger ${expected}`);
    }
  }
  for (const [engine, expected] of ledgerKnown) {
    if (!cost.byEngine.some((bucket) => bucket.engine === engine)) {
      differences.push(`byEngine has no ${engine}, but the ledger has ${expected}`);
    }
  }
  return differences;
}

test("the live read and the synced ledger are one number (AC-19)", async () => {
  const admin = fakeAdmin(fixtureTables());
  const cost = await getScanCost(admin, JOB, BRAND);
  const ledger = await readLedger(admin, JOB);

  // The ledger holds one row per synced attempt, and no row for the attempt
  // the sync leaves out: an explore observation is not a scan answer.
  const synced = FIXTURE_ATTEMPTS.filter((attempt) => attempt.purpose === "scan");
  assert.equal(ledger.length, synced.length, "one ledger row per synced attempt");
  assert.deepEqual(
    ledger.map((row) => String(row.source_ref)).sort(),
    synced
      .map((attempt) => `probe_attempt:${attempt.observation_id}:${attempt.attempt_no}`)
      .sort()
  );

  // AC-19: the read's total is the ledger's total, and each engine's known
  // figure is that engine's ledger sum.
  assert.deepEqual(
    ledgerDifferences(cost, ledger),
    [],
    "the live read and the synced ledger must be the same number"
  );
  near(cost.totalAccountedUsd, 0.6713, "totalAccountedUsd");
  near(cost.knownUsd, 0.0713, "knownUsd");
  near(cost.reservedUnknownUsd, 0.6, "reservedUnknownUsd");

  for (const bucket of cost.byEngine) {
    const expected = attemptLedgerRows(ledger)
      .filter((row) => String((row.meta as Row | undefined)?.engine ?? "") === bucket.engine)
      .filter((row) => {
        const source = String(row.cost_source ?? "");
        return source === "provider_reported" || source === "price_table";
      })
      .reduce((sum, row) => sum + Number(row.accounted_usd ?? 0), 0);
    near(bucket.knownUsd, expected, `byEngine[${bucket.engine}].knownUsd`);
  }

  // Not a tautology: a ledger row that drifted away from the attempts must be
  // caught, or this test would prove nothing.
  const drifted = ledger.map((row) =>
    row.source_ref === "probe_attempt:f03-obs-01:1" ? { ...row, accounted_usd: 0.5 } : row
  );
  assert.ok(
    ledgerDifferences(cost, drifted).length > 0,
    "a drifted ledger row must be detected, or this test proves nothing"
  );
});

