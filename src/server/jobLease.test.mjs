import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireLease,
  renewLease,
  releaseLease,
  leaseIsFree,
  newLeaseOwner,
  LEASE_TTL_MS,
} from "./jobLease.js";

/**
 * Durable job lease (T1). The point of these tests is the CAS: of two callers
 * racing the same row, exactly one may win. The mock client therefore does not
 * return canned data — it EVALUATES the filters against a stored row, including
 * the PostgREST `or(...)` expression, so the "loser matches 0 rows" behaviour is
 * genuinely exercised rather than assumed.
 *
 * Self-contained fake client, matching this repo's per-file test convention
 * (see the note in dbContent.test.mjs).
 */

// --- fake Supabase client that really applies filters ------------------------

/** Evaluate one PostgREST `or()` expression against a row. */
function evalOr(row, expr) {
  return expr.split(",").some((clause) => {
    const m = clause.match(/^([a-z_]+)\.([a-z]+)\.(.*)$/);
    if (!m) return false;
    const [, col, op, rawVal] = m;
    const val = rawVal.replace(/^"/, "").replace(/"$/, "");
    if (op === "is") return val === "null" ? row[col] == null : false;
    if (op === "eq") return row[col] === val;
    if (op === "lt") return row[col] != null && new Date(row[col]) < new Date(val);
    return false;
  });
}

function makeLeaseClient(initialRows, { failWith = null } = {}) {
  const rows = new Map(initialRows.map((r) => [r.id, { ...r }]));
  const client = {
    from(table) {
      const state = { table, op: null, values: null, eqs: [], or: null };
      const builder = {
        update(vals) {
          state.op = "update";
          state.values = vals;
          return builder;
        },
        select() {
          if (!state.op) state.op = "select";
          return builder;
        },
        eq(col, val) {
          state.eqs.push([col, val]);
          return builder;
        },
        or(expr) {
          state.or = expr;
          return builder;
        },
        then(resolve, reject) {
          if (failWith) {
            Promise.resolve().then(() => resolve({ data: null, error: failWith }));
            return;
          }
          let matched = Array.from(rows.values()).filter((r) =>
            state.eqs.every(([col, val]) => r[col] === val)
          );
          if (state.or) matched = matched.filter((r) => evalOr(r, state.or));
          if (state.op === "update") {
            matched.forEach((r) => Object.assign(r, state.values));
          }
          Promise.resolve().then(() =>
            resolve({ data: matched.map((r) => ({ ...r })), error: null })
          );
        },
      };
      return builder;
    },
  };
  return { client, rows };
}

const FREE_ROW = { id: "job-1", lease_owner: null, lease_expires_at: null };

// --- acquire ----------------------------------------------------------------

test("acquireLease: a free row is granted and stamped with owner + expiry", async () => {
  const { client, rows } = makeLeaseClient([FREE_ROW]);
  const before = Date.now();

  const won = await acquireLease("content_jobs", "job-1", "run_a", { client });

  assert.ok(won, "the only caller must win");
  assert.equal(won.lease_owner, "run_a");
  const expiresMs = new Date(rows.get("job-1").lease_expires_at).getTime();
  assert.ok(expiresMs >= before + LEASE_TTL_MS - 50, "expiry is ~now + TTL");
});

test("acquireLease: a second, different owner LOSES against a live lease", async () => {
  const { client } = makeLeaseClient([FREE_ROW]);

  const first = await acquireLease("content_jobs", "job-1", "run_a", { client });
  const second = await acquireLease("content_jobs", "job-1", "run_b", { client });

  assert.ok(first, "first caller wins");
  assert.equal(second, null, "second caller must lose — this is the D1 fix");
});

test("acquireLease: the SAME owner re-acquiring is idempotent, not a loss", async () => {
  const { client } = makeLeaseClient([FREE_ROW]);

  await acquireLease("content_jobs", "job-1", "run_a", { client });
  const again = await acquireLease("content_jobs", "job-1", "run_a", { client });

  assert.ok(again, "re-acquiring your own live lease must succeed");
  assert.equal(again.lease_owner, "run_a");
});

test("acquireLease: an EXPIRED lease is stealable — a crashed worker cannot block forever", async () => {
  const expired = new Date(Date.now() - 60_000).toISOString();
  const { client } = makeLeaseClient([
    { id: "job-1", lease_owner: "run_dead", lease_expires_at: expired },
  ]);

  const won = await acquireLease("content_jobs", "job-1", "run_b", { client });

  assert.ok(won, "an expired lease must be reclaimable");
  assert.equal(won.lease_owner, "run_b");
});

test("acquireLease: an unknown job id grants nothing", async () => {
  const { client } = makeLeaseClient([FREE_ROW]);
  assert.equal(await acquireLease("content_jobs", "nope", "run_a", { client }), null);
});

test("acquireLease: a DB error THROWS — never silently grants (fail-loud, L4)", async () => {
  const { client } = makeLeaseClient([FREE_ROW], { failWith: new Error("db down") });
  await assert.rejects(
    () => acquireLease("content_jobs", "job-1", "run_a", { client }),
    /db down/
  );
});

// --- renew ------------------------------------------------------------------

test("renewLease: the holder pushes the expiry out; a non-holder gets null", async () => {
  const { client, rows } = makeLeaseClient([FREE_ROW]);
  await acquireLease("content_jobs", "job-1", "run_a", { client, nowMs: Date.now() - 10_000 });
  const firstExpiry = rows.get("job-1").lease_expires_at;

  const renewed = await renewLease("content_jobs", "job-1", "run_a", { client });
  assert.ok(renewed);
  assert.ok(
    new Date(rows.get("job-1").lease_expires_at) > new Date(firstExpiry),
    "renewal must extend the expiry"
  );

  assert.equal(
    await renewLease("content_jobs", "job-1", "run_b", { client }),
    null,
    "a worker that lost the lease must not be able to renew it"
  );
});

// --- release ----------------------------------------------------------------

test("releaseLease: the holder frees the row for the next worker", async () => {
  const { client, rows } = makeLeaseClient([FREE_ROW]);
  await acquireLease("content_jobs", "job-1", "run_a", { client });

  assert.equal(await releaseLease("content_jobs", "job-1", "run_a", { client }), true);
  assert.equal(rows.get("job-1").lease_owner, null);

  const next = await acquireLease("content_jobs", "job-1", "run_b", { client });
  assert.ok(next, "a released row is immediately claimable");
});

test("releaseLease: a non-holder cannot free someone else's lease", async () => {
  const { client, rows } = makeLeaseClient([FREE_ROW]);
  await acquireLease("content_jobs", "job-1", "run_a", { client });

  assert.equal(await releaseLease("content_jobs", "job-1", "run_b", { client }), false);
  assert.equal(rows.get("job-1").lease_owner, "run_a", "lease survives a foreign release");
});

// --- pure predicate ---------------------------------------------------------

test("leaseIsFree: unowned, self-owned, and expired are free; a live foreign lease is not", () => {
  const now = Date.now();
  const future = new Date(now + 60_000).toISOString();
  const past = new Date(now - 60_000).toISOString();

  assert.equal(leaseIsFree({ lease_owner: null }, null, now), true);
  assert.equal(leaseIsFree({ lease_owner: "a", lease_expires_at: future }, "a", now), true);
  assert.equal(leaseIsFree({ lease_owner: "a", lease_expires_at: past }, null, now), true);
  assert.equal(leaseIsFree({ lease_owner: "a", lease_expires_at: future }, null, now), false);
  assert.equal(leaseIsFree(null, null, now), false);
});

// --- memory mode ------------------------------------------------------------

test("memory mode: a row in the store gets a real lease and blocks a rival", async () => {
  const memory = new Map([["job-1", { id: "job-1" }]]);

  const first = await acquireLease("content_jobs", "job-1", "run_a", { client: null, memory });
  const second = await acquireLease("content_jobs", "job-1", "run_b", { client: null, memory });

  assert.ok(first);
  assert.equal(second, null);
  assert.equal(memory.get("job-1").lease_owner, "run_a");

  assert.equal(await releaseLease("content_jobs", "job-1", "run_a", { client: null, memory }), true);
  assert.ok(await acquireLease("content_jobs", "job-1", "run_b", { client: null, memory }));
});

test("memory mode: a row absent from the store is granted synthetically", async () => {
  const memory = new Map();
  const won = await acquireLease("content_jobs", "ghost", "run_a", { client: null, memory });

  // Nothing to contend — the worker tests inject deps.job and never touch the
  // store, and must not be refused as "already leased".
  assert.ok(won);
  assert.equal(won.lease_owner, "run_a");
  assert.ok(await renewLease("content_jobs", "ghost", "run_a", { client: null, memory }));
  assert.equal(await releaseLease("content_jobs", "ghost", "run_a", { client: null, memory }), true);
});

test("newLeaseOwner produces distinct prefixed ids", () => {
  const a = newLeaseOwner("cron");
  const b = newLeaseOwner("cron");
  assert.notEqual(a, b);
  assert.match(a, /^cron_/);
});
