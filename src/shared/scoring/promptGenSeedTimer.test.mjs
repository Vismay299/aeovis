/**
 * R3.7.6 (finding A1) — the PAA seed-term deadline must be CLEARED, not waited out.
 *
 * `generateUnbrandedPrompts` races each seed term's PAA + autocomplete fetch
 * against a 10s timeout. The timeout used to be scheduled and forgotten, so a
 * call that finished in 50ms still held one live Timeout per seed term (up to
 * five) for the next ten seconds: a serverless invocation kept open past its
 * work, and on the long-lived fleet a stranded timer per term per scan.
 *
 * These tests do not check the return value — a correct return proves nothing
 * about the timer. They measure the timer itself, two independent ways:
 *   1. a setTimeout/clearTimeout spy, so every 10s deadline created during the
 *      call must have a matching clear (on the success path AND the throw path);
 *   2. process.getActiveResourcesInfo, the same instrument R6.5.6 used on
 *      src/shared/gemini.js — the pending-Timeout delta across the call is zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateUnbrandedPrompts, SEED_FETCH_TIMEOUT_MS } from "./promptGen.js";

const brand = "Acme";
const website = "https://acme.io";
// Yields 5 distinct seed terms (label + 3 label words + website-title words),
// i.e. 5 deadlines per call — the multiplier that made this leak worth fixing.
const industry = "Project Management Software";

function makeItems(prefix, n) {
  return Array.from({ length: n }, (_, i) => ({
    text: `${prefix} query number ${i} example`,
    topic: "General",
    intent_tier: "informational",
  }));
}

const enoughPrompts = async () => makeItems("clean", 40);

/**
 * Wraps the global timer functions so the test can see every timer the code
 * under test schedules and every one it retires. Real timers underneath: a
 * deadline that is never cleared stays genuinely pending, which is exactly the
 * condition being asserted against.
 */
function installTimerSpy() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const created = [];
  const live = new Map();

  globalThis.setTimeout = (fn, delay, ...args) => {
    const handle = realSet(fn, delay, ...args);
    created.push({ handle, delay });
    live.set(handle, delay);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    live.delete(handle);
    return realClear(handle);
  };

  return {
    created,
    /** deadlines scheduled at the seed-term timeout that are still pending */
    liveSeedDeadlines: () => [...live.values()].filter((d) => d === SEED_FETCH_TIMEOUT_MS),
    seedDeadlinesCreated: () => created.filter((c) => c.delay === SEED_FETCH_TIMEOUT_MS).length,
    restore() {
      // Anything still pending would outlive the test run; retire it.
      for (const handle of live.keys()) realClear(handle);
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

function captureWarnings() {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  return { lines, restore: () => { console.warn = original; } };
}

test("every seed-term deadline is cleared when the fetch wins the race", async () => {
  const spy = installTimerSpy();
  try {
    const prompts = await generateUnbrandedPrompts(brand, website, industry, {}, 30, {
      scrapeForSummary: async () => "Manage projects with teams and software",
      fetchPeopleAlsoAsk: async () => ["how do teams pick a tool"],
      fetchAutocomplete: async () => ["best tool for teams"],
      llmJson: enoughPrompts,
    });

    assert.equal(prompts.length, 30);
    assert.ok(
      spy.seedDeadlinesCreated() >= 2,
      `the test must actually reach seeding — it scheduled ${spy.seedDeadlinesCreated()} deadlines`
    );
    assert.deepEqual(
      spy.liveSeedDeadlines(),
      [],
      `each seed term's ${SEED_FETCH_TIMEOUT_MS}ms deadline must be cleared once its fetch settles`
    );
  } finally {
    spy.restore();
  }
});

test("a seed-term deadline is cleared on the throw path too", async () => {
  const spy = installTimerSpy();
  const warned = captureWarnings();
  try {
    const prompts = await generateUnbrandedPrompts(brand, website, industry, {}, 30, {
      scrapeForSummary: async () => "Manage projects with teams and software",
      fetchPeopleAlsoAsk: async () => { throw new Error("serp 503"); },
      fetchAutocomplete: async () => { throw new Error("serp 503"); },
      llmJson: enoughPrompts,
    });

    assert.equal(prompts.length, 30, "seeding is best-effort; the run still completes");
    assert.ok(spy.seedDeadlinesCreated() >= 2);
    assert.deepEqual(
      spy.liveSeedDeadlines(),
      [],
      "a rejected fetch must not leave its deadline pending — the clear belongs in a finally"
    );
    // Rule 1: a term that produced nothing may not look like a term that had nothing.
    assert.ok(
      warned.lines.some((l) => l.includes("[promptGen] seed fetch failed") && l.includes("serp 503")),
      `the swallowed per-term failure must be logged; saw: ${JSON.stringify(warned.lines)}`
    );
  } finally {
    warned.restore();
    spy.restore();
  }
});

test("when the deadline does fire, the term is reported and the timer is still retired", async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set();
  let firedDeadlines = 0;

  // Collapse the 10s deadline to ~0ms so the expiry path is exercised without
  // waiting for it; every other timer keeps its real delay.
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay === SEED_FETCH_TIMEOUT_MS) {
      firedDeadlines += 1;
      const handle = realSet(fn, 0, ...args);
      live.add(handle);
      return handle;
    }
    return realSet(fn, delay, ...args);
  };
  globalThis.clearTimeout = (handle) => {
    live.delete(handle);
    return realClear(handle);
  };

  const warned = captureWarnings();
  try {
    const prompts = await generateUnbrandedPrompts(brand, website, industry, {}, 30, {
      scrapeForSummary: async () => "Manage projects with teams and software",
      // Never settles: only the deadline can end this term.
      fetchPeopleAlsoAsk: () => new Promise(() => {}),
      fetchAutocomplete: () => new Promise(() => {}),
      llmJson: enoughPrompts,
    });

    assert.equal(prompts.length, 30);
    assert.ok(firedDeadlines >= 2, "the seeding loop must have raced a deadline per term");
    assert.equal(
      live.size,
      0,
      "an EXPIRED deadline is still cleared — the finally runs on the timeout path as well"
    );
    assert.ok(
      warned.lines.some((l) => l.includes("[promptGen] seed fetch failed") && l.includes("timeout")),
      `a timed-out seed term must say so; saw: ${JSON.stringify(warned.lines)}`
    );
  } finally {
    warned.restore();
    for (const handle of live) realClear(handle);
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

// ---------------------------------------------------------------------------
// The R6.5.6 instrument, applied to prompt generation: count the event loop's
// pending Timeout handles before and after. Delta must be zero.
// ---------------------------------------------------------------------------

const countTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

test("pending-Timeout delta across prompt generation is zero", async () => {
  const before = countTimers();
  const prompts = await generateUnbrandedPrompts(brand, website, industry, {}, 30, {
    scrapeForSummary: async () => "Manage projects with teams and software",
    fetchPeopleAlsoAsk: async () => ["how do teams pick a tool"],
    fetchAutocomplete: async () => ["best tool for teams"],
    llmJson: enoughPrompts,
  });
  const after = countTimers();

  assert.equal(prompts.length, 30);
  assert.equal(
    after - before,
    0,
    "prompt generation returned with seed-term deadlines still pending on the event loop"
  );
});
