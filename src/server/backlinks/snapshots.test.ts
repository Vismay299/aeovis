import assert from "node:assert/strict";
import test from "node:test";
import { getJobDefinition } from "../jobs/registry.ts";
import { SpendRefused } from "../../shared/spend/errors.ts";
import { AppError } from "../../shared/http/appError.ts";
import {
  SNAPSHOTS_TICK_KIND,
  registerBacklinkSnapshotJobs,
  resetBacklinkSnapshotJobsDeps,
} from "./jobs.ts";
import { createSnapshotTarget, deleteSnapshotTarget, recordLookupSnapshot, type DueSnapshotTarget } from "./snapshots.ts";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const due = (key: string, observedNextRunAt = "2026-11-14T12:00:00.000Z"): DueSnapshotTarget => ({
  key,
  observedNextRunAt,
  interval: "weekly",
  brandKey: `brand-${key}`,
  target: `${key}.example`,
  scope: "subdomains",
  approvedMaxUsd: 0.5,
  workspaceActive: true,
});

type HarnessOptions = {
  items?: DueSnapshotTarget[];
  snapshotsEnabled?: boolean;
  active?: boolean;
  quoteUsd?: number;
  summary?: (target: DueSnapshotTarget, ctx: unknown, input: unknown) => Promise<unknown>;
  advance?: (target: DueSnapshotTarget) => Promise<boolean>;
};

async function runTick(options: HarnessOptions = {}) {
  const items = options.items ?? [due("one")];
  const events: string[] = [];
  const blocked: Array<{ key: string; reason: string; next: string }> = [];
  const summaryCalls: Array<{ target: DueSnapshotTarget; ctx: any; input: any }> = [];
  const recordCalls: any[] = [];
  const stepCalls: Array<{ name: string; opts: any }> = [];
  let quoteCalls = 0;
  const admin = {} as any;
  registerBacklinkSnapshotJobs({
    admin,
    now: () => NOW,
    listDue: async () => items,
    scheduleDeps: {
      isFeatureEnabled: async () => options.snapshotsEnabled ?? true,
      isBrandActive: async () => options.active ?? true,
      quote: async () => {
        quoteCalls += 1;
        return { blocked: false, totalUsd: options.quoteUsd ?? 0.1 } as any;
      },
    },
    advanceTarget: async (_admin, item) => {
      events.push(`advance:${item.key}`);
      return options.advance ? options.advance(item) : true;
    },
    blockTarget: async (_admin, item, plan, reason) => {
      blocked.push({ key: item.key, reason, next: plan.next });
      events.push(`block:${item.key}:${reason}`);
    },
    createBacklinksClient: (() => ({
      summary: async (ctx: any, input: any) => {
        const item = items.find((candidate) => candidate.brandKey === ctx.brandKey) ?? items[0];
        summaryCalls.push({ target: item, ctx, input });
        events.push(`summary:${item.key}`);
        if (options.summary) return options.summary(item, ctx, input);
        return { target: item.target, backlinks: 12, referring_domains: 3 };
      },
    })) as any,
    record: async (_admin, input) => {
      recordCalls.push(input);
      events.push(`record:${input.brandKey}`);
    },
    logger: { log: () => undefined, error: () => undefined, warn: () => undefined },
  });
  const definition = getJobDefinition(SNAPSHOTS_TICK_KIND);
  assert.ok(definition, "snapshot tick job is registered");
  const ctx = {
    jobId: "job-snapshot-test",
    brandKey: "system",
    payload: {},
    trigger: "system",
    step: {
      do: async (name: string, opts: any, fn: () => Promise<unknown>) => {
        stepCalls.push({ name, opts });
        return fn();
      },
      sleep: async () => undefined,
    },
    progress: async () => undefined,
  };
  try {
    const result = await definition.handler(ctx as any);
    return { result, events, blocked, summaryCalls, recordCalls, stepCalls, quoteCalls };
  } finally {
    resetBacklinkSnapshotJobsDeps();
  }
}

test("due weekly target advances before one approved billed summary is captured", async () => {
  const item = { ...due("one"), approvedMaxUsd: 0.024036 };
  const { result, events, summaryCalls, recordCalls, stepCalls } = await runTick({
    items: [item],
    quoteUsd: 0.024036,
  });
  assert.deepEqual(events.slice(0, 3), ["advance:one", "summary:one", `record:brand-one`]);
  assert.equal(summaryCalls.length, 1);
  assert.equal(summaryCalls[0].ctx.feature, "backlinks.snapshots");
  assert.equal(summaryCalls[0].ctx.maxUsd, 0.024036);
  assert.equal(summaryCalls[0].ctx.jobId, "job-snapshot-test");
  assert.equal(summaryCalls[0].ctx.idempotencyKey, "backlinks.snapshot:one:2026-11-14T12:00:00.000Z");
  assert.equal(recordCalls[0].source, "scheduled");
  const billedWindow = stepCalls.find((call) => call.name.startsWith("window:"));
  assert.deepEqual(billedWindow?.opts, { timeoutMs: 60_000, retries: 0, billed: true });
  assert.deepEqual(result, { status: "completed", result: { started: 1, skipped: {}, failed: 0, notDue: 0 } });
});

test("flag off records snapshots_disabled without quote or provider call", async () => {
  const item = due("disabled");
  const result = await runTick({ items: [item], snapshotsEnabled: false });
  assert.equal(result.summaryCalls.length, 0);
  assert.deepEqual(result.blocked, [{ key: item.key, reason: "snapshots_disabled", next: "2026-11-21T12:00:00.000Z" }]);
  assert.deepEqual((result.result as any).result, { started: 0, skipped: { snapshots_disabled: 1 }, failed: 0, notDue: 0 });
  assert.equal(result.quoteCalls, 0);
});

test("price above the approved maximum skips before provider work", async () => {
  const item = { ...due("price-rise"), approvedMaxUsd: 0.024036 };
  const result = await runTick({ items: [item], quoteUsd: 0.024037 });
  assert.equal(result.summaryCalls.length, 0);
  assert.deepEqual(result.blocked, [{ key: item.key, reason: "price_changed", next: "2026-11-21T12:00:00.000Z" }]);
});

test("missed weekly windows collapse to one capture", async () => {
  const result = await runTick({ items: [due("catchup", "2026-10-18T12:00:00.000Z")] });
  assert.equal(result.summaryCalls.length, 1);
  assert.equal(result.recordCalls.length, 1);
});

test("a spend refusal is recorded and the next target still runs", async () => {
  const first = due("refused");
  const second = due("next");
  const result = await runTick({
    items: [first, second],
    summary: async (item) => {
      if (item.key === first.key) throw new SpendRefused("daily_cap");
      return { target: item.target, backlinks: 1 };
    },
  });
  assert.deepEqual(result.blocked, [{ key: "refused", reason: "daily_cap", next: "2026-11-21T12:00:00.000Z" }]);
  assert.equal(result.summaryCalls.length, 2);
  assert.equal(result.recordCalls.length, 1);
  assert.equal(result.recordCalls[0].brandKey, second.brandKey);
});

test("failed capture records start_failed and does not stop the next target", async () => {
  const first = due("failed");
  const second = due("continues");
  const result = await runTick({
    items: [first, second],
    summary: async (item) => {
      if (item.key === first.key) throw new Error("fixture failure");
      return { target: item.target, backlinks: 1 };
    },
  });
  assert.deepEqual(result.blocked, [{ key: "failed", reason: "start_failed", next: "2026-11-21T12:00:00.000Z" }]);
  assert.equal(result.recordCalls.length, 1);
  assert.equal(result.recordCalls[0].brandKey, second.brandKey);
});

function lookupAdmin(tracked: boolean) {
  let upsert: { row: any; options: any } | null = null;
  const targetQuery: any = {
    eq() { return this; },
    maybeSingle: async () => ({ data: tracked ? { id: "tracked-id" } : null, error: null }),
  };
  const snapshotsQuery: any = {
    upsert: async (row: any, options: any) => {
      upsert = { row, options };
      return { error: null };
    },
  };
  return {
    admin: {
      from(table: string) {
        return table === "backlink_snapshot_targets"
          ? { select: () => targetQuery }
          : snapshotsQuery;
      },
    } as any,
    getUpsert: () => upsert,
  };
}

test("lookup writes only for an enabled tracked target and relies on per-day conflict ignore", async () => {
  const overview = {
    target: "offcult.in",
    summary: {
      rank: 40, backlinks: 100, referringDomains: 20, referringPages: 30,
      brokenBacklinks: 1, brokenPages: 2, newBacklinks: 3, lostBacklinks: 4,
      newReferringDomains: 5, lostReferringDomains: 6, backlinksSpamScore: 7, targetSpamScore: 8,
    },
  } as any;
  const untracked = lookupAdmin(false);
  assert.equal(await recordLookupSnapshot(untracked.admin, {
    brandKey: "brand-a", target: "offcult.in", scope: "subdomains", overview,
    now: new Date("2026-11-15T23:59:59.000Z"),
  }), false);
  assert.equal(untracked.getUpsert(), null);

  const tracked = lookupAdmin(true);
  assert.equal(await recordLookupSnapshot(tracked.admin, {
    brandKey: "brand-a", target: "offcult.in", scope: "subdomains", overview,
    now: new Date("2026-11-15T23:59:59.000Z"),
  }), true);
  assert.deepEqual(tracked.getUpsert()?.options, {
    onConflict: "brand_key,target,scope,captured_on", ignoreDuplicates: true,
  });
  assert.equal(tracked.getUpsert()?.row.captured_on, "2026-11-15");
  assert.equal(tracked.getUpsert()?.row.source, "lookup");
});

test("an already enabled normalized target is rejected as a duplicate", async () => {
  let inserts = 0;
  const query: any = {
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({ data: { id: "existing", enabled: true }, error: null }),
    insert() { inserts += 1; return this; },
  };
  const admin = { from: () => query } as any;
  await assert.rejects(
    createSnapshotTarget(admin, {
      brandKey: "brand-a", target: "offcult.in", scope: "subdomains", interval: "weekly",
      approvedMaxUsd: 0.5, nextRunAt: "2026-11-21T12:00:00.000Z",
    }),
    (error: unknown) => error instanceof AppError && error.status === 409 && error.code === "already_tracked",
  );
  assert.equal(inserts, 0);
});

test("a target id outside the authenticated workspace is indistinguishable from missing", async () => {
  const query: any = {
    update() { return this; },
    eq() { return this; },
    select() { return this; },
    maybeSingle: async () => ({ data: null, error: null }),
  };
  const admin = { from: () => query } as any;
  await assert.rejects(
    deleteSnapshotTarget(admin, "workspace-a", "workspace-b-target"),
    (error: unknown) => error instanceof AppError && error.status === 404 && error.code === "snapshot_target_not_found",
  );
});
