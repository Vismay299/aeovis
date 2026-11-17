import assert from "node:assert/strict";
import { test } from "node:test";
import { getJobDefinition } from "../../jobs/registry.ts";
import { listPeriodics } from "../../jobs/periodic.ts";
import {
  QUESTIONS_LINK_KIND,
  QUESTIONS_LINKS_PRUNE_LIMIT,
  QUESTIONS_LINKS_RETENTION_KIND,
  registerQuestionLinkJobs,
} from "./jobs.ts";

function fakeAdmin(brands: string[], pruneBatches: number[] = []) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const admin = {
    from(table: string) {
      assert.equal(table, "customer_brands");
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: async () => ({ data: brands.map((brand_key) => ({ brand_key })), error: null }),
      };
      return chain;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (fn === "prune_question_answer_links") return { data: pruneBatches.shift() ?? 0, error: null };
      return { data: { scan: 1, explore: 0, legacy: 2, imported: 0, unmatched: 0 }, error: null };
    },
  };
  return { admin, rpcCalls };
}

function fakeCtx() {
  const steps: string[] = [];
  return {
    steps,
    ctx: {
      payload: {},
      step: {
        async do(name: string, _opts: unknown, fn: () => Promise<unknown>) {
          steps.push(name);
          return fn();
        },
      },
    },
  };
}

test("questions.link lists brands in a step, then links each workspace in its own step", async () => {
  const { admin, rpcCalls } = fakeAdmin(["brand-a", "brand-b"]);
  registerQuestionLinkJobs({ admin: admin as any });
  try {
    const def: any = getJobDefinition(QUESTIONS_LINK_KIND);
    assert.ok(def);
    const { ctx, steps } = fakeCtx();
    const out = await def.handler(ctx);
    assert.deepEqual(steps, ["list", "link-1", "link-2"]);
    assert.deepEqual(
      rpcCalls.map((c) => [c.args.p_brand, c.args.p_limit, c.args.p_linked_by, c.args.p_import_missing]),
      [
        ["brand-a", 2000, "periodic", false],
        ["brand-b", 2000, "periodic", false],
      ],
    );
    assert.deepEqual(out, { result: { linked: 6 } });
  } finally {
    registerQuestionLinkJobs({ admin: null });
  }
});

test("questions.links.retention prunes in batches until a short batch", async () => {
  const { admin, rpcCalls } = fakeAdmin([], [QUESTIONS_LINKS_PRUNE_LIMIT, 12]);
  const now = new Date("2026-11-14T00:00:00Z");
  registerQuestionLinkJobs({ admin: admin as any, now: () => now });
  try {
    const def: any = getJobDefinition(QUESTIONS_LINKS_RETENTION_KIND);
    const { ctx, steps } = fakeCtx();
    const out = await def.handler(ctx);
    assert.deepEqual(steps, ["prune-1", "prune-2"]);
    assert.equal(rpcCalls[0].args.p_before, new Date(now.getTime() - 395 * 86_400_000).toISOString());
    assert.deepEqual(out, { result: { pruned: QUESTIONS_LINKS_PRUNE_LIMIT + 12 } });
  } finally {
    registerQuestionLinkJobs({ admin: null, now: null });
  }
});

test("both periodics are registered", () => {
  const names = listPeriodics().map((p) => p.name);
  assert.ok(names.includes(QUESTIONS_LINK_KIND));
  assert.ok(names.includes(QUESTIONS_LINKS_RETENTION_KIND));
});
