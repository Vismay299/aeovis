import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkExploreRateLimits } from "./rateLimit.ts";
import { AppError } from "../../shared/http/errors.ts";

describe("src/server/explore/rateLimit.ts", () => {
  const dummyClient = {} as any;
  const now = new Date("2026-10-22T10:30:00.000Z");

  it("passes when within limits and no active run exists", async () => {
    await assert.doesNotReject(async () => {
      await checkExploreRateLimits(
        dummyClient,
        {
          brandKey: "brand-1",
          userId: "user-1",
          now,
        },
        {
          findActiveRun: async () => null,
          listUserRunsInWindow: async () => [],
          countWorkspaceRunsSince: async () => 0,
        },
      );
    });
  });

  it("throws 409 explore_already_running when user has a queued or running run", async () => {
    await assert.rejects(
      async () => {
        await checkExploreRateLimits(
          dummyClient,
          {
            brandKey: "brand-1",
            userId: "user-1",
            now,
          },
          {
            findActiveRun: async () => ({ id: "active-run-123" }),
            listUserRunsInWindow: async () => [],
            countWorkspaceRunsSince: async () => 0,
          },
        );
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 409);
        assert.equal(err.code, "explore_already_running");
        assert.equal(err.message, "Your previous question is still being answered.");
        assert.equal(err.details?.activeRunId, "active-run-123");
        return true;
      },
    );
  });

  it("throws 429 explore_rate_limited when user exceeds hourly limit", async () => {
    // 10 runs in the last hour, oldest was 20 minutes ago (40 minutes remaining)
    const oldestRunTime = new Date(now.getTime() - 20 * 60_000).toISOString();
    const mockRuns = Array.from({ length: 10 }, (_, i) => ({
      id: `run-${i}`,
      created_at: oldestRunTime,
    }));

    await assert.rejects(
      async () => {
        await checkExploreRateLimits(
          dummyClient,
          {
            brandKey: "brand-1",
            userId: "user-1",
            now,
            env: { EXPLORE_MAX_RUNS_PER_USER_HOUR: "10" },
          },
          {
            findActiveRun: async () => null,
            listUserRunsInWindow: async () => mockRuns,
            countWorkspaceRunsSince: async () => 0,
          },
        );
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 429);
        assert.equal(err.code, "explore_rate_limited");
        assert.equal(err.message, "You have asked a lot of questions recently. Try again in 40 minutes.");
        assert.equal(err.recovery, "Wait, then ask again.");
        assert.equal(err.details?.retryAfterSeconds, 2400);
        return true;
      },
    );
  });

  it("throws 429 explore_rate_limited when workspace reaches UTC day limit", async () => {
    await assert.rejects(
      async () => {
        await checkExploreRateLimits(
          dummyClient,
          {
            brandKey: "brand-1",
            userId: "user-1",
            now,
            env: { EXPLORE_MAX_RUNS_PER_WORKSPACE_DAY: "30" },
          },
          {
            findActiveRun: async () => null,
            listUserRunsInWindow: async () => [],
            countWorkspaceRunsSince: async () => 30,
          },
        );
      },
      (err: any) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.status, 429);
        assert.equal(err.code, "explore_rate_limited");
        assert.equal(
          err.message,
          "This workspace has reached today's limit of 30 questions. Try again tomorrow.",
        );
        assert.equal(err.recovery, "Wait, then ask again.");
        assert.ok(typeof err.details?.retryAfterSeconds === "number");
        assert.ok(err.details.retryAfterSeconds > 0);
        return true;
      },
    );
  });
});
