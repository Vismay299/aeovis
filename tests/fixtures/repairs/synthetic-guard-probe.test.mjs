import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

/**
 * R21-04 fixture — what the offline suite's child processes get.
 *
 * WHY A FIXTURE RATHER THAN AN ASSERTION INSIDE THE HARNESS TEST. R21-04 says a
 * paid/live call attempted inside `--suite offline` must fail before dispatch.
 * The runner answers that two ways: it refuses to dispatch a case whose declared
 * level is live at all, and every child it does dispatch carries
 * `--import ./src/lib/liveWriteGuardAuto.mjs`. The second claim is only worth
 * anything if that preload has teeth in a child, so this file is executed with
 * exactly that preload and asserts the guard refuses the write.
 *
 * THE STATEMENT IS DELIBERATELY A REAL WRITE TO A CUSTOMER TABLE. `scans` is on
 * the guard's NEVER_WRITABLE list, so the refusal happens before a socket is
 * opened: this test cannot reach a database even if one is configured. The
 * connection string is never used for a connection and carries a fake password.
 *
 * WHAT IT CANNOT PROVE, STATED HERE. In this repository's dependency set the
 * guard reports `PARTIALLY ARMED — supabase=false pg=true`: it cannot patch
 * `@supabase/supabase-js` because of a broken transitive import, so a PostgREST
 * write is not covered by this probe. The pg transport is the one it does cover.
 */
test("GUARD-PROBE — an undeclared live write is refused in a child test process", async () => {
  const client = new pg.Client({
    connectionString: "postgresql://postgres:sk-example-not-a-real-key@qa-example.invalid:5432/postgres",
    connectionTimeoutMillis: 1,
  });

  await assert.rejects(
    () => client.query("insert into scans (id) values ($1)", ["guard-probe"]),
    (err) => {
      assert.equal(err.name, "LiveWriteRefused", `expected the write guard to refuse, got ${err.name}: ${err.message}`);
      assert.match(err.message, /insert\(\)|sql write|scans/);
      return true;
    }
  );
});
