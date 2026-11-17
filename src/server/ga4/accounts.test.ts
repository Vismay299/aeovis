import test from "node:test";
import assert from "node:assert/strict";
import {
  getRemovalImpact,
  removeGoogleAccount,
  purgeUnusedGrants,
} from "./accounts.ts";
import { encryptToken } from "../gsc/oauthCrypto.js";

process.env.GSC_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("getRemovalImpact: delegates to grantImpact RPC", async () => {
  const mockAdmin = {
    rpc: async (fn: string, params: any) => {
      if (fn === "ga4_grant_impact") {
        assert.equal(params.p_user_id, "u1");
        assert.equal(params.p_grant_id, "g1");
        return { data: 2, error: null };
      }
      throw new Error(`Unexpected rpc: ${fn}`);
    },
  };

  const impact = await getRemovalImpact(mockAdmin, "u1", "g1");
  assert.deepEqual(impact, { workspaces: 2 });
});

test("removeGoogleAccount: returns { removed: false, workspacesDisconnected: 0 } if grant not found or not owned", async () => {
  const mockAdmin = {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: new Error("Not found") }),
          }),
        }),
      }),
    }),
  };

  const res = await removeGoogleAccount(mockAdmin, "u1", "missing-grant");
  assert.deepEqual(res, { removed: false, workspacesDisconnected: 0 });
});

test("removeGoogleAccount: removes dependent connections, purges cache, and revokes when last grant for account", async () => {
  const userId = "u1";
  const googleSub = "sub-1";
  const rawAccessToken = "ya29.valid-token";
  const encAccessToken = JSON.stringify(encryptToken(rawAccessToken, `ga4:${userId}:${googleSub}:access`));

  let purgedBrands: string[] = [];
  let revokedToken: string | null = null;

  const mockAdmin = {
    from: (table: string) => ({
      select: () => ({
        eq: (_c1: string, _v1: string) => ({
          eq: (_c2: string, _v2: string) => ({
            single: async () => ({
              data: {
                id: "g1",
                user_id: userId,
                google_sub: googleSub,
                encrypted_access_token: encAccessToken,
                access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
                status: "active",
                updated_at: new Date().toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
    }),
    rpc: async (fn: string, params: any) => {
      if (fn === "ga4_remove_grant") {
        return {
          data: {
            removed: true,
            googleSub,
            brands: ["brand-a", "brand-b"],
            remainingForGoogleAccount: 0,
          },
          error: null,
        };
      }
      if (fn === "ga4_purge_cache") {
        purgedBrands.push(params.p_brand_key);
        return { data: [], error: null };
      }
      throw new Error(`Unexpected rpc: ${fn}`);
    },
  };

  const mockFetch = (async (url: string, opts: any) => {
    if (url.includes("revoke")) {
      const body = opts.body.toString();
      revokedToken = new URLSearchParams(body).get("token");
      return new Response("", { status: 200 });
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  const res = await removeGoogleAccount(mockAdmin, userId, "g1", { fetchImpl: mockFetch });
  assert.equal(res.removed, true);
  assert.equal(res.workspacesDisconnected, 2);
  assert.deepEqual(purgedBrands, ["brand-a", "brand-b"]);
  assert.equal(revokedToken, rawAccessToken);
});

test("removeGoogleAccount: does NOT revoke token if other grants for that Google sub remain", async () => {
  const userId = "u1";
  const googleSub = "sub-shared";
  const rawAccessToken = "ya29.valid-token";
  const encAccessToken = JSON.stringify(encryptToken(rawAccessToken, `ga4:${userId}:${googleSub}:access`));

  let revokeCalled = false;

  const mockAdmin = {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: "g1",
                user_id: userId,
                google_sub: googleSub,
                encrypted_access_token: encAccessToken,
                access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
                status: "active",
                updated_at: new Date().toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
    }),
    rpc: async (fn: string) => {
      if (fn === "ga4_remove_grant") {
        return {
          data: {
            removed: true,
            googleSub,
            brands: ["brand-a"],
            remainingForGoogleAccount: 1, // Another user or grant still uses this sub
          },
          error: null,
        };
      }
      if (fn === "ga4_purge_cache") {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected rpc: ${fn}`);
    },
  };

  const mockFetch = (async () => {
    revokeCalled = true;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  const res = await removeGoogleAccount(mockAdmin, userId, "g1", { fetchImpl: mockFetch });
  assert.equal(res.removed, true);
  assert.equal(revokeCalled, false);
});

test("removeGoogleAccount: revocation network failure is logged and does not prevent removal success", async () => {
  const userId = "u1";
  const googleSub = "sub-1";
  const rawAccessToken = "ya29.valid-token";
  const encAccessToken = JSON.stringify(encryptToken(rawAccessToken, `ga4:${userId}:${googleSub}:access`));

  const mockAdmin = {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: "g1",
                user_id: userId,
                google_sub: googleSub,
                encrypted_access_token: encAccessToken,
                access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
                status: "active",
                updated_at: new Date().toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
    }),
    rpc: async (fn: string) => {
      if (fn === "ga4_remove_grant") {
        return {
          data: {
            removed: true,
            googleSub,
            brands: [],
            remainingForGoogleAccount: 0,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected rpc: ${fn}`);
    },
  };

  const mockFetch = (async () => {
    return new Response("Server error", { status: 500 });
  }) as unknown as typeof fetch;

  const res = await removeGoogleAccount(mockAdmin, userId, "g1", { fetchImpl: mockFetch });
  assert.equal(res.removed, true);
});

test("purgeUnusedGrants: purges and revokes grants updated before cutoff", async () => {
  const cutoff = new Date(Date.now() - 86_400_000);
  const rawAccessToken = "ya29.purge-token";
  const encAccessToken = JSON.stringify(encryptToken(rawAccessToken, "ga4:u1:sub-purge:access"));

  let revokedTokens: string[] = [];

  const mockAdmin = {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "unused-1",
              user_id: "u1",
              google_sub: "sub-purge",
              encrypted_access_token: encAccessToken,
              access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
              status: "active",
              updated_at: new Date(cutoff.getTime() - 1000).toISOString(),
            },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (fn: string) => {
      if (fn === "ga4_list_unused_grants") {
        return {
          data: [{ id: "unused-1", user_id: "u1", google_sub: "sub-purge" }],
          error: null,
        };
      }
      if (fn === "ga4_delete_unused_grant") {
        return {
          data: { deleted: true, remainingForGoogleAccount: 0 },
          error: null,
        };
      }
      throw new Error(`Unexpected rpc: ${fn}`);
    },
  };

  const mockFetch = (async (url: string, opts: any) => {
    if (url.includes("revoke")) {
      const body = opts.body.toString();
      revokedTokens.push(new URLSearchParams(body).get("token") || "");
      return new Response("", { status: 200 });
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await purgeUnusedGrants(
    mockAdmin,
    { updatedBefore: cutoff },
    { fetchImpl: mockFetch },
  );

  assert.equal(result.purged, 1);
  assert.equal(result.revoked, 1);
  assert.deepEqual(revokedTokens, [rawAccessToken]);
});
