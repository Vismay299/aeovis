import test from "node:test";
import assert from "node:assert/strict";
import {
  generateIndexNowKey,
  indexNowDomain,
  indexNowHosts,
  getSetup,
  ensureKey,
} from "./keys.ts";
import { AppError } from "../http/errors.ts";

test("generateIndexNowKey produces 32 lowercase hex characters", () => {
  const key = generateIndexNowKey();
  assert.match(key, /^[0-9a-f]{32}$/);
});

test("generateIndexNowKey uses injected UUID generator if provided", () => {
  const customUuid = () => "12345678-9ABC-DEF0-1234-56789ABCDEF0";
  const key = generateIndexNowKey(customUuid);
  assert.equal(key, "123456789abcdef0123456789abcdef0");
  assert.match(key, /^[0-9a-f]{32}$/);
});

test("indexNowDomain lowercases and strips leading www. (F19-AC-03)", () => {
  assert.equal(indexNowDomain({ website_host: "Example.COM" }), "example.com");
  assert.equal(indexNowDomain({ website_host: "www.example.com" }), "example.com");
  assert.equal(indexNowDomain({ website_host: "WWW.EXAMPLE.COM" }), "example.com");
  assert.equal(indexNowDomain({ website_host: "blog.example.com" }), "blog.example.com");
});

test("indexNowDomain rejects empty or missing website_host", () => {
  assert.throws(
    () => indexNowDomain({ website_host: "" }),
    (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "invalid_request"
  );
  assert.throws(
    // @ts-expect-error testing invalid input
    () => indexNowDomain({ website_host: null }),
    (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "invalid_request"
  );
});

test("indexNowHosts returns domain and www.<domain>", () => {
  assert.deepEqual(indexNowHosts("example.com"), ["example.com", "www.example.com"]);
});

test("getSetup returns null key and false ready when no key row exists", async () => {
  const admin: any = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  };

  const ws = { brandKey: "b1", brand: { website_host: "example.com" } };
  const res = await getSetup(admin, ws);
  assert.deepEqual(res, {
    domain: "example.com",
    key: null,
    hosts: null,
    checkedAt: null,
    ready: false,
  });
});

test("getSetup returns setup with ready=true when hosts are verified", async () => {
  const admin: any = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => ({
            data: {
              key: "0123456789abcdef0123456789abcdef",
              last_check: [
                { host: "example.com", status: "found" },
                { host: "www.example.com", status: "moved" },
              ],
              last_checked_at: "2026-10-22T09:00:00.000Z",
            },
            error: null,
          }),
        }),
      }),
    }),
  };

  const ws = { brandKey: "b1", brand: { website_host: "example.com" } };
  const res = await getSetup(admin, ws);
  assert.equal(res.domain, "example.com");
  assert.equal(res.key, "0123456789abcdef0123456789abcdef");
  assert.equal(res.ready, true);
  assert.equal(res.checkedAt, "2026-10-22T09:00:00.000Z");
  assert.equal(res.hosts?.length, 2);
});

test("ensureKey creates key on first use (created: true) and returns existing on rerun (created: false)", async () => {
  let storedKey: string | null = null;
  const admin: any = {
    rpc: async (_fn: string, params: { p_brand: string; p_key: string; p_actor: string | null }) => {
      if (!storedKey) {
        storedKey = params.p_key;
        return { data: [{ key: storedKey, created: true }], error: null };
      }
      return { data: [{ key: storedKey, created: false }], error: null };
    },
  };

  const ws = { brandKey: "b1", brand: { website_host: "example.com" }, user: { id: "u1" } };
  const first = await ensureKey(admin, ws, { generateKey: () => "0123456789abcdef0123456789abcdef" });
  assert.equal(first.created, true);
  assert.equal(first.key, "0123456789abcdef0123456789abcdef");

  const second = await ensureKey(admin, ws, { generateKey: () => "fedcba9876543210fedcba9876543210" });
  assert.equal(second.created, false);
  // Converges on first key
  assert.equal(second.key, "0123456789abcdef0123456789abcdef");
});
