/**
 * R1.2.23(b) — an idle fleet costs ONE scan_runs row per idle stretch.
 *
 * WHY THIS FILE EXISTS AT ALL, stated plainly so it is not deleted as a
 * duplicate of scanRunReaper.test.mjs: the first cut of R1.2.23 shipped the
 * whole idle-stretch machinery — `createIdleStretch`, `holdIdleRow`,
 * `closeIdleRow`, `IDLE_END_REASONS` — and never called any of it. `runOnce`
 * still opened and closed a row per poll, `start()` never built a stretch, and
 * the suite was green: 3121 tests, 0 failures, with the feature entirely dead.
 * Every test that existed drove either a pure function (`idleHeartbeatPlan`) or
 * a synthetic row literal, and none of them ran the fleet's own loop.
 *
 * So the rule here is: drive `runOnce` and `start` themselves, through injected
 * deps, and count the LEDGER CALLS. A test that asserts on the stretch object
 * instead of on `openRun`/`closeRun`/`heartbeatRun` would have passed against
 * the dead version too, which makes it worthless as a guard.
 *
 * The clock is injected (`deps.now`) rather than real, so "24 hours of idleness"
 * is 8,640 polls that run in milliseconds and the beat arithmetic is exact
 * rather than timing-dependent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fleet = await import(pathToFileURL(path.join(REPO, "worker/src/index.js")).href);
const runLedger = await import(pathToFileURL(path.join(REPO, "worker/src/lib/runLedger.js")).href);

const { runOnce, start, createIdleStretch, IDLE_END_REASONS, IDLE_VERDICTS } = fleet;

const CONFIG = Object.freeze({
  workerId: "worker-test-host-7",
  engines: ["perplexity"],
  heartbeatMs: 30_000,
  idlePollMs: 10_000,
  batchSize: 2,
});

/**
 * Stubs for the three ledger writes plus a clock the test advances by hand.
 * `calls` is the whole assertion surface — what reached the database.
 */
function ledgerSpy({ beatFailsOn = [] } = {}) {
  const spy = {
    opens: [],
    closes: [],
    beats: [],
    beatAttempts: 0,
    nowMs: 1_700_000_000_000,
    nextId: 1,
  };
  spy.deps = {
    now: () => spy.nowMs,
    claimBatch: async () => ({
      owner: CONFIG.workerId,
      tasks: [],
      claimedCount: 0,
      outstanding: 0,
      leasedElsewhere: 0,
      reason: "queue_empty",
    }),
    openRun: async (fields) => {
      const id = `run-${spy.nextId++}`;
      spy.opens.push({ id, ...fields });
      return runLedger.normalizeRun({
        id,
        runner: "probe-fleet",
        phase: fields.phase,
        worker_id: fields.workerId,
        started_at: new Date(spy.nowMs).toISOString(),
        heartbeat_at: new Date(spy.nowMs).toISOString(),
      });
    },
    heartbeatRun: async (runId) => {
      spy.beatAttempts += 1;
      if (beatFailsOn.includes(spy.beatAttempts)) {
        // What heartbeat_scan_run actually raises when the sweep closed the row.
        throw new Error(`heartbeat_scan_run: no open run ${runId} exists`);
      }
      spy.beats.push({ runId, at: spy.nowMs });
      return { id: runId, heartbeatAt: new Date(spy.nowMs).toISOString() };
    },
    closeRun: async (runId, fields) => {
      spy.closes.push({ runId, ...fields });
      return runLedger.normalizeRun({
        id: runId,
        runner: "probe-fleet",
        phase: "idle",
        worker_id: CONFIG.workerId,
        outcome: fields.outcome,
        reason: fields.reason,
        started_at: new Date(spy.nowMs).toISOString(),
        heartbeat_at: new Date(spy.nowMs).toISOString(),
        ended_at: new Date(spy.nowMs).toISOString(),
      });
    },
  };
  return spy;
}

/** Poll `n` times through the real runOnce, advancing the clock like the loop. */
async function poll(spy, stretch, n) {
  for (let i = 0; i < n; i += 1) {
    await runOnce(CONFIG, spy.deps, stretch);
    spy.nowMs += CONFIG.idlePollMs;
  }
}

test("ten idle polls open ONE row and close none — this is the whole point of R1.2.23", async () => {
  const spy = ledgerSpy();
  const stretch = createIdleStretch();
  await poll(spy, stretch, 10);

  assert.equal(spy.opens.length, 1, "one row for the stretch, not one per poll");
  assert.equal(spy.closes.length, 0, "the stretch is still running, so nothing is closed yet");
  assert.equal(spy.opens[0].phase, "idle");
  assert.equal(spy.opens[0].workerId, CONFIG.workerId);
  assert.equal(stretch.polls, 10);
});

test("24 h of unbroken idleness costs ONE row and a bounded number of beats", async () => {
  const spy = ledgerSpy();
  const stretch = createIdleStretch();
  const polls = (24 * 60 * 60 * 1000) / CONFIG.idlePollMs; // 8,640

  await poll(spy, stretch, polls);

  // The accept clause says "order of tens, not thousands". The row count is the
  // number retention and the 500 MB budget care about; it is ONE.
  assert.equal(spy.opens.length, 1, `${polls} polls must not write ${polls} rows`);
  assert.equal(spy.closes.length, 0);
  // Beats are UPDATEs, not rows, but they are still traffic, so pin them too.
  // One beat per heartbeatMs, i.e. every third poll, less the opening poll —
  // open_scan_run stamps heartbeat_at itself, so the first beat is due one
  // cadence after the row exists, not immediately.
  assert.equal(spy.beats.length, polls / 3 - 1, "2,879 beats: one per heartbeatMs across the day");
  assert.ok(spy.beats.length < 3_000, "bounded, and an UPDATE each — never a new row");
});

test("the poll INSIDE the beat window writes nothing at all", async () => {
  const spy = ledgerSpy();
  const stretch = createIdleStretch();

  assert.equal(await holdVerdict(spy, stretch), IDLE_VERDICTS.OPENED);
  spy.nowMs += CONFIG.idlePollMs; // +10s, inside the 30s window
  assert.equal(await holdVerdict(spy, stretch), IDLE_VERDICTS.HELD);
  assert.equal(spy.beats.length, 0, "a held poll is not a beat");
  assert.equal(spy.opens.length, 1);

  spy.nowMs += 2 * CONFIG.idlePollMs; // +30s total: the beat is due
  assert.equal(await holdVerdict(spy, stretch), IDLE_VERDICTS.BEAT);
  assert.equal(spy.beats.length, 1);
});

/** One poll, reporting what the stretch did — runOnce returns the task count. */
async function holdVerdict(spy, stretch) {
  const beforeOpens = spy.opens.length;
  const beforeBeats = spy.beats.length;
  await runOnce(CONFIG, spy.deps, stretch);
  if (spy.opens.length > beforeOpens) {
    return stretch.reopens > 0 && spy.opens.length > 1 ? IDLE_VERDICTS.REOPENED : IDLE_VERDICTS.OPENED;
  }
  return spy.beats.length > beforeBeats ? IDLE_VERDICTS.BEAT : IDLE_VERDICTS.HELD;
}

test("a row reaped underneath the pod is REOPENED, so an idle fleet never reads as a dead one", async () => {
  // Fail the second beat: the sweep closed the row while this container idled.
  const spy = ledgerSpy({ beatFailsOn: [2] });
  const stretch = createIdleStretch();

  await poll(spy, stretch, 12); // 120s: beats due at 30/60/90/120

  assert.equal(spy.opens.length, 2, "exactly one fresh row after the rejection — not one per poll");
  assert.equal(stretch.reopens, 1);
  assert.equal(spy.opens[1].detail.opened_because, IDLE_VERDICTS.REOPENED);
  assert.equal(spy.opens[1].detail.reopens, 1, "the closed row's successor says it is one");
  assert.equal(spy.closes.length, 0, "a reaped row is not ours to close");
});

test("work arriving closes the stretch as work_claimed, with measured zeroes", async () => {
  const spy = ledgerSpy();
  const stretch = createIdleStretch();
  await poll(spy, stretch, 5);

  // Now the queue has something. The batch path is stubbed out entirely: this
  // test is about the idle row's fate, not about probing.
  spy.deps.claimBatch = async () => ({
    owner: CONFIG.workerId,
    tasks: [{ id: "t1", engine: "perplexity", query: "q" }],
    claimedCount: 1,
    outstanding: 1,
    leasedElsewhere: 0,
    reason: "claimed",
  });
  spy.deps.probeBatch = async (batch) => batch.map((t) => ({ ...t, outcome: "skipped", detail: {} }));
  spy.deps.reportBatch = async (o) => ({ asked: o.length, applied: o.length, rejected: [] });

  await runOnce(CONFIG, spy.deps, stretch);

  const idleClose = spy.closes.find((c) => c.detail && "ended_because" in c.detail);
  assert.ok(idleClose, "the idle row must be closed when work arrives");
  assert.equal(idleClose.detail.ended_because, IDLE_END_REASONS.WORK_CLAIMED);
  assert.equal(idleClose.outcome, "noop");
  assert.equal(idleClose.reason, "queue_empty", "the claim's own vocabulary, not a generic 'idle'");
  assert.equal(idleClose.probesAttempted, 0, "a measured zero, not an absent count");
  assert.equal(idleClose.detail.idle_polls, 5);
  assert.equal(stretch.runId, null, "the stretch is reset, so nothing keeps beating a closed row");
});

test("a caller with no stretch owns only its pass: open, then close, within it", async () => {
  const spy = ledgerSpy();
  await runOnce(CONFIG, spy.deps); // no stretch argument — the --selftest shape

  assert.equal(spy.opens.length, 1);
  assert.equal(spy.closes.length, 1, "an idle row must never outlive the thing that can beat it");
  assert.equal(spy.closes[0].detail.ended_because, IDLE_END_REASONS.PASS_ENDED);
});

test("start() closes its stretch on the way out — process_exit, best effort", async () => {
  const spy = ledgerSpy();
  await start({ ...CONFIG, once: true }, { ...spy.deps, sleep: async () => {} });

  assert.equal(spy.opens.length, 1, "one idle row for the whole loop");
  assert.equal(spy.closes.length, 1);
  assert.equal(spy.closes[0].detail.ended_because, IDLE_END_REASONS.PROCESS_EXIT);
});

test("start() runs several polls against ONE row before exiting", async () => {
  const spy = ledgerSpy();
  let polls = 0;
  const deps = {
    ...spy.deps,
    sleep: async () => {
      spy.nowMs += CONFIG.idlePollMs;
      polls += 1;
      // The loop checks `running` at the top, so the pass in flight finishes
      // and the next one never starts: nine sleeps means nine polls, not ten.
      if (polls >= 9) process.emit("SIGTERM");
    },
  };
  await start(CONFIG, deps);

  assert.equal(spy.opens.length, 1, "nine idle polls, one row");
  assert.equal(spy.closes.length, 1);
  assert.equal(spy.closes[0].detail.idle_polls, 9);
  assert.equal(spy.closes[0].detail.ended_because, IDLE_END_REASONS.PROCESS_EXIT);
});
