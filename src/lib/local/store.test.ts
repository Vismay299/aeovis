import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../http/appError.ts";
import { mapSaveBusinessError, supabaseLocalStore } from "./store.ts";

type Reply = { data?: unknown; error?: { message?: string; code?: string } | null; count?: number };

/** A chainable fake of the PostgREST client that records every call and answers from a queue. */
function fakeAdmin(replies: Reply[]) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const next = (): Reply => replies.shift() ?? { data: null, error: null };
  const builder = (table: string): any => {
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const reply = next();
            return (resolve: (v: Reply) => void) => resolve({ error: null, ...reply });
          }
          return (...args: unknown[]) => {
            calls.push({ op: `${table}.${prop}`, args });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  const admin = {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: unknown) => {
      calls.push({ op: `rpc.${fn}`, args: [args] });
      return { error: null, ...next() };
    },
  };
  return { admin: admin as never, calls };
}

test("saveBusiness calls save_local_business with the SQL parameter names", async () => {
  const { admin, calls } = fakeAdmin([{ data: "biz-1" }]);
  const id = await supabaseLocalStore(admin).saveBusiness({
    brandKey: "b", role: "own", title: "Acme", cid: "123", latitude: 1.5, longitude: 2.5, locationCode: 2840, languageCode: "en", profile: { title: "Acme" }, actor: "u1",
  });
  assert.equal(id, "biz-1");
  assert.deepEqual(calls[0], {
    op: "rpc.save_local_business",
    args: [{ p_brand: "b", p_role: "own", p_title: "Acme", p_cid: "123", p_place_id: null, p_lat: 1.5, p_lng: 2.5, p_location_code: 2840, p_language: "en", p_profile: { title: "Acme" }, p_actor: "u1" }],
  });
});

test("saveBusiness retries once on a unique violation and maps the other errors", async () => {
  const unique = { code: "23505", message: "duplicate key" };
  const retry = fakeAdmin([{ error: unique }, { data: "biz-2" }]);
  assert.equal(await supabaseLocalStore(retry.admin).saveBusiness({ brandKey: "b", role: "competitor", title: "A", cid: "1" }), "biz-2");
  assert.equal(retry.calls.length, 2);

  const twice = fakeAdmin([{ error: unique }, { error: unique }]);
  await assert.rejects(
    supabaseLocalStore(twice.admin).saveBusiness({ brandKey: "b", role: "competitor", title: "A", cid: "1" }),
    (err: unknown) => err instanceof AppError && err.status === 503 && err.code === "local_unavailable",
  );

  const capped = fakeAdmin([{ error: { message: "local_business_cap:competitors" } }]);
  await assert.rejects(
    supabaseLocalStore(capped.admin).saveBusiness({ brandKey: "b", role: "competitor", title: "A", cid: "1" }),
    (err: unknown) => err instanceof AppError && err.status === 409 && err.code === "competitor_limit",
  );
});

test("mapSaveBusinessError follows the spec table", () => {
  const cap = mapSaveBusinessError({ message: "x local_business_cap:competitors y" });
  assert.deepEqual([cap.status, cap.code, cap.message], [409, "competitor_limit", "You can save up to 10 local competitors. Remove one first."]);
  const invalid = mapSaveBusinessError({ message: "local_business_invalid:role" });
  assert.deepEqual([invalid.status, invalid.code], [400, "invalid_request"]);
  const other = mapSaveBusinessError({ message: "connection reset" });
  assert.deepEqual([other.status, other.code, other.message], [503, "local_unavailable", "Local data could not be saved. Please retry."]);
});

test("findReuse and claimPoll use the SQL function parameter names; a failed rpc is 503 local_unavailable", async () => {
  const { admin, calls } = fakeAdmin([{ data: "fetch-1" }, { data: true }, { data: false }, { error: { message: "boom" } }]);
  const store = supabaseLocalStore(admin);
  assert.equal(await store.findReuse("b", "fetch", "h".repeat(64), "2026-11-10T00:00:00.000Z"), "fetch-1");
  assert.deepEqual(calls[0], { op: "rpc.find_local_reuse", args: [{ p_brand: "b", p_table: "fetch", p_hash: "h".repeat(64), p_since: "2026-11-10T00:00:00.000Z" }] });
  assert.equal(await store.claimPoll("b", "grid", "g1"), true);
  assert.deepEqual(calls[1], { op: "rpc.claim_local_poll", args: [{ p_brand: "b", p_table: "grid", p_id: "g1", p_min_seconds: 4 }] });
  assert.equal(await store.claimPoll("b", "grid", "g1"), false);
  await assert.rejects(store.claimPoll("b", "grid", "g1"), (err: unknown) => err instanceof AppError && err.code === "local_unavailable");
});

test("insertFetch ignores duplicates on request_id and returns the existing row when it conflicts", async () => {
  const existing = { id: "f1", request_id: "r1", status: "completed" };
  const { admin, calls } = fakeAdmin([{ data: [] }, { data: existing }]);
  const out = await supabaseLocalStore(admin).insertFetch({
    brandKey: "b", requestId: "r1", businessId: null, kind: "reviews", identifier: { cid: "1" }, params: { depth: 20 }, paramsHash: "h".repeat(64), requestedBy: null,
  });
  assert.deepEqual(out, { row: existing, created: false });
  const upsert = calls.find((c) => c.op === "local_fetches.upsert");
  assert.deepEqual(upsert?.args[1], { onConflict: "request_id", ignoreDuplicates: true });
});

test("every query is scoped to the workspace brand_key", async () => {
  const { admin, calls } = fakeAdmin([{ data: [] }, { data: null }, { data: [] }]);
  const store = supabaseLocalStore(admin);
  await store.listBusinesses("brand-a");
  await store.getFetch("brand-a", "f1");
  await store.listGrids("brand-a", 5);
  const scoped = calls.filter((c) => c.op.endsWith(".eq") && c.args[0] === "brand_key");
  assert.equal(scoped.length, 3);
  assert.ok(scoped.every((c) => c.args[1] === "brand-a"));
});
