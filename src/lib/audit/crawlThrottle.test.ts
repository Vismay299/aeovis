// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/crawl-throttle.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCrawlThrottle,
  parseRetryAfterMs,
} from "./crawlThrottle.ts";

describe("parseRetryAfterMs", () => {
  it("returns null for null or empty header", () => {
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs(""), null);
  });

  it("parses numeric seconds into milliseconds", () => {
    assert.equal(parseRetryAfterMs("5"), 5_000);
    assert.equal(parseRetryAfterMs(" 60 "), 60_000);
  });

  it("caps oversized numeric values to MAX_COOLDOWN_MS + 1", () => {
    const capped = parseRetryAfterMs("99999999");
    assert.equal(capped, 30 * 60_000 + 1);
  });

  it("parses HTTP date", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfterMs(future);
    assert.ok(parsed !== null && parsed > 5_000 && parsed <= 11_000);
  });

  it("returns null for invalid strings", () => {
    assert.equal(parseRetryAfterMs("not-a-date-or-number"), null);
  });
});

describe("createCrawlThrottle", () => {
  it("allows immediate request if now is under deadline", async () => {
    const throttle = createCrawlThrottle(Date.now() + 10_000, undefined, undefined, {
      initialIntervalMs: 10,
    });
    const canRun = await throttle.ready();
    assert.equal(canRun, true);
    assert.equal(throttle.stopped, false);
  });

  it("returns false from ready if deadline has passed", async () => {
    const throttle = createCrawlThrottle(Date.now() - 100);
    const canRun = await throttle.ready();
    assert.equal(canRun, false);
  });

  it("tracks rate limits, adjusts interval, and pauses requests", async () => {
    let savedState: any = null;
    const throttle = createCrawlThrottle(
      Date.now() + 100_000,
      undefined,
      async (s) => {
        savedState = s;
      },
      { initialIntervalMs: 50 },
    );

    const mayRetry = await throttle.backoff(1, "1");
    assert.equal(mayRetry, true);
    assert.equal(throttle.state.consecutiveRateLimits, 1);
    assert.equal(throttle.state.intervalMs, 100);
    assert.ok(throttle.state.pausedUntil > Date.now());
    assert.ok(savedState !== null);

    await throttle.recovered();
    assert.equal(throttle.state.consecutiveRateLimits, 0);
  });

  it("stops after consecutive refusals exceed MAX_RETRIES (3)", async () => {
    let throttle = createCrawlThrottle(Date.now() + 100_000, undefined, undefined, {
      initialIntervalMs: 10,
    });

    for (let i = 0; i < 3; i++) {
      const ok = await throttle.backoff(1, "0");
      assert.equal(ok, true);
    }
    // 4th refusal
    const ok4 = await throttle.backoff(1, "0");
    assert.equal(ok4, false);
    assert.equal(throttle.stopped, true);
    assert.equal(await throttle.ready(), false);
  });

  it("stops when cumulative cooldowns exceed MAX_COOLDOWN_MS", async () => {
    const throttle = createCrawlThrottle(Date.now() + 100_000, {
      intervalMs: 1_000,
      nextRequestAt: 0,
      pausedUntil: 0,
      consecutiveRateLimits: 0,
      cooldownMs: 31 * 60_000,
    });
    assert.equal(throttle.stopped, true);
    assert.equal(await throttle.ready(), false);
  });

  it("flags checkpointFailed when persist throws", async () => {
    const throttle = createCrawlThrottle(
      Date.now() + 10_000,
      undefined,
      async () => {
        throw new Error("DB write error");
      },
    );

    await assert.rejects(async () => {
      await throttle.backoff(1, "1");
    });
    assert.equal(throttle.checkpointFailed, true);
    assert.equal(throttle.stopped, true);
  });

  it("preserves state across restart", async () => {
    const initial = createCrawlThrottle(Date.now() + 50_000, undefined, undefined, {
      initialIntervalMs: 500,
    });
    await initial.backoff(1, "2");

    const resumed = createCrawlThrottle(Date.now() + 50_000, initial.state);
    assert.equal(resumed.state.consecutiveRateLimits, 1);
    assert.equal(resumed.state.intervalMs, 1_000);
    assert.equal(resumed.state.pausedUntil, initial.state.pausedUntil);
  });
});
