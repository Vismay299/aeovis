import test from "node:test";
import assert from "node:assert/strict";
import {
  readIndexNowLimits,
  assertSubmitAllowed,
  assertCheckAllowed,
} from "./limits.ts";
import { AppError } from "../http/errors.ts";

test("readIndexNowLimits returns defaults when env is empty", () => {
  const limits = readIndexNowLimits({});
  assert.equal(limits.maxRequestsPerHour, 30);
  assert.equal(limits.maxUrlsPerDay, 10000);
  assert.equal(limits.maxChecksPerHour, 60);
  assert.equal(limits.resubmitCooldownSeconds, 600);
});

test("readIndexNowLimits parses valid environment values", () => {
  const limits = readIndexNowLimits({
    INDEXNOW_MAX_REQUESTS_PER_HOUR: "50",
    INDEXNOW_MAX_URLS_PER_DAY: "20000",
    INDEXNOW_MAX_HOST_CHECKS_PER_HOUR: "100",
    INDEXNOW_RESUBMIT_COOLDOWN_SECONDS: "300",
  });
  assert.equal(limits.maxRequestsPerHour, 50);
  assert.equal(limits.maxUrlsPerDay, 20000);
  assert.equal(limits.maxChecksPerHour, 100);
  assert.equal(limits.resubmitCooldownSeconds, 300);
});

test("readIndexNowLimits throws 500 indexnow_config_invalid on invalid values", () => {
  assert.throws(
    () => readIndexNowLimits({ INDEXNOW_MAX_REQUESTS_PER_HOUR: "not_a_number" }),
    (err: unknown) => err instanceof AppError && err.status === 500 && err.code === "indexnow_config_invalid"
  );
  assert.throws(
    () => readIndexNowLimits({ INDEXNOW_MAX_REQUESTS_PER_HOUR: "0" }), // below min 1
    (err: unknown) => err instanceof AppError && err.status === 500 && err.code === "indexnow_config_invalid"
  );
  assert.throws(
    () => readIndexNowLimits({ INDEXNOW_MAX_REQUESTS_PER_HOUR: "1001" }), // above max 1000
    (err: unknown) => err instanceof AppError && err.status === 500 && err.code === "indexnow_config_invalid"
  );
  assert.throws(
    () => readIndexNowLimits({ INDEXNOW_MAX_URLS_PER_DAY: "100001" }),
    (err: unknown) => err instanceof AppError && err.status === 500 && err.code === "indexnow_config_invalid"
  );
  assert.throws(
    () => readIndexNowLimits({ INDEXNOW_MAX_HOST_CHECKS_PER_HOUR: "1" }), // below min 2
    (err: unknown) => err instanceof AppError && err.status === 500 && err.code === "indexnow_config_invalid"
  );
  assert.throws(
    () => readIndexNowLimits({ INDEXNOW_RESUBMIT_COOLDOWN_SECONDS: "-1" }),
    (err: unknown) => err instanceof AppError && err.status === 500 && err.code === "indexnow_config_invalid"
  );
});

test("assertSubmitAllowed: 31st request throws 429 indexnow_rate_limited with retryAfterSeconds", async () => {
  const admin: any = {};
  const now = new Date("2026-10-22T10:30:00.000Z");
  // Oldest request in hour was at 10:05:00 -> window rolls at 11:05:00 (in 35 minutes = 2100 seconds)
  const oldestRequestInHour = "2026-10-22T10:05:00.000Z";

  await assert.rejects(
    () =>
      assertSubmitAllowed(admin, "b1", 1, now, undefined, {
        getUsage: async () => ({
          requestsLastHour: 30, // at limit
          oldestRequestInHour,
          urlsToday: 10,
          checksLastHour: 0,
          oldestCheckInHour: null,
        }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "indexnow_rate_limited");
      assert.match(err.message, /You've submitted to IndexNow 30 times in the last hour\. Try again in 35 minutes\./);
      assert.equal(err.recovery, "Submit only pages you added or changed.");
      assert.equal(err.details?.retryAfterSeconds, 2100);
      return true;
    }
  );
});

test("assertSubmitAllowed: 10,001st URL throws 429 until next UTC midnight", async () => {
  const admin: any = {};
  const now = new Date("2026-10-22T23:00:00.000Z"); // 1 hour (3600 seconds) before midnight UTC

  await assert.rejects(
    () =>
      assertSubmitAllowed(admin, "b1", 1, now, undefined, {
        getUsage: async () => ({
          requestsLastHour: 5,
          oldestRequestInHour: "2026-10-22T22:30:00.000Z",
          urlsToday: 10000, // 10000 + 1 = 10001
          checksLastHour: 0,
          oldestCheckInHour: null,
        }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "indexnow_rate_limited");
      assert.match(
        err.message,
        /This workspace has submitted 10000 URLs today\. The daily limit is 10000\. Try again tomorrow\./
      );
      assert.equal(err.recovery, "Submit only pages you added or changed.");
      assert.equal(err.details?.retryAfterSeconds, 3600);
      return true;
    }
  );
});

test("assertCheckAllowed: 61st host check throws 429", async () => {
  const admin: any = {};
  const now = new Date("2026-10-22T10:30:00.000Z");
  // Oldest check was at 10:10:00 -> window rolls at 11:10:00 (in 40 minutes = 2400 seconds)
  const oldestCheckInHour = "2026-10-22T10:10:00.000Z";

  await assert.rejects(
    () =>
      assertCheckAllowed(admin, "b1", 2, now, undefined, {
        getUsage: async () => ({
          requestsLastHour: 0,
          oldestRequestInHour: null,
          urlsToday: 0,
          checksLastHour: 59, // 59 + 2 = 61 > 60
          oldestCheckInHour,
        }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "indexnow_rate_limited");
      assert.match(
        err.message,
        /The key file was checked 59 times in the last hour\. Try again in 40 minutes\./
      );
      assert.equal(err.recovery, "Submit only pages you added or changed.");
      assert.equal(err.details?.retryAfterSeconds, 2400);
      return true;
    }
  );
});

test("assertSubmitAllowed and assertCheckAllowed pass within limits", async () => {
  const admin: any = {};
  const now = new Date("2026-10-22T10:30:00.000Z");

  await assertSubmitAllowed(admin, "b1", 10, now, undefined, {
    getUsage: async () => ({
      requestsLastHour: 5,
      oldestRequestInHour: "2026-10-22T10:00:00.000Z",
      urlsToday: 100,
      checksLastHour: 10,
      oldestCheckInHour: "2026-10-22T10:00:00.000Z",
    }),
  });

  await assertCheckAllowed(admin, "b1", 2, now, undefined, {
    getUsage: async () => ({
      requestsLastHour: 5,
      oldestRequestInHour: "2026-10-22T10:00:00.000Z",
      urlsToday: 100,
      checksLastHour: 10,
      oldestCheckInHour: "2026-10-22T10:00:00.000Z",
    }),
  });
});
