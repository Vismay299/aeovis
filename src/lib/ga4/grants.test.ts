import test from "node:test";
import assert from "node:assert/strict";
import {
  upsertGrant,
  listGrantsForUser,
  getGrant,
  grantImpact,
  removeGrant,
  listUnusedGrants,
  deleteUnusedGrant,
  purgeCache,
} from "./grants.ts";
import { decryptToken } from "../gsc/oauthCrypto.js";

process.env.GSC_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("upsertGrant: encrypts tokens with user and sub AAD and calls ga4_upsert_grant", async () => {
  let rpcParams: any = null;
  const mockAdmin = {
    rpc: async (fn: string, params: any) => {
      if (fn === "ga4_upsert_grant") {
        rpcParams = params;
        return { data: "grant-uuid-1", error: null };
      }
      throw new Error(`Unexpected rpc: ${fn}`);
    },
  };

  const grantId = await upsertGrant(mockAdmin, {
    userId: "user-1",
    googleSub: "sub-1",
    googleEmail: "owner@example.com",
    refreshToken: "refresh-plain",
    accessToken: "access-plain",
    accessTokenExpiresAt: "2026-11-07T12:00:00.000Z",
    scopes: ["openid", "email"],
  });

  assert.equal(grantId, "grant-uuid-1");
  assert.equal(rpcParams.p_user_id, "user-1");
  assert.equal(rpcParams.p_google_sub, "sub-1");
  assert.equal(rpcParams.p_google_email, "owner@example.com");

  // Verify decryption with correct AAD
  const decRefresh = decryptToken(
    JSON.parse(rpcParams.p_encrypted_refresh_token),
    "ga4:user-1:sub-1:refresh",
  );
  assert.equal(decRefresh, "refresh-plain");

  const decAccess = decryptToken(
    JSON.parse(rpcParams.p_encrypted_access_token),
    "ga4:user-1:sub-1:access",
  );
  assert.equal(decAccess, "access-plain");
});

test("listGrantsForUser: queries grants and computes workspace usage counts", async () => {
  const mockAdmin = {
    from: (table: string) => {
      if (table === "ga4_grants") {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({
                data: [
                  {
                    id: "g1",
                    google_sub: "s1",
                    google_email: "a@example.com",
                    status: "active",
                    created_at: "2026-10-01T00:00:00Z",
                  },
                  {
                    id: "g2",
                    google_sub: "s2",
                    google_email: "b@example.com",
                    status: "error",
                    created_at: "2026-10-02T00:00:00Z",
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "ga4_connections") {
        return {
          select: () => Promise.resolve({
            data: [
              { grant_id: "g1" },
              { grant_id: "g1" },
              { grant_id: "other" },
            ],
            error: null,
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  const list = await listGrantsForUser(mockAdmin, "user-1");
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    grantId: "g1",
    email: "a@example.com",
    status: "active",
    linkedAt: "2026-10-01T00:00:00Z",
    workspaces: 2,
  });
  assert.deepEqual(list[1], {
    grantId: "g2",
    email: "b@example.com",
    status: "error",
    linkedAt: "2026-10-02T00:00:00Z",
    workspaces: 0,
  });
});

test("getGrant: finds grant by id and optional user_id", async () => {
  const mockAdmin = {
    from: (_table: string) => ({
      select: () => ({
        eq: (_col1: string, val1: string) => ({
          single: async () => {
            if (val1 === "grant-1") {
              return { data: { id: "grant-1", google_sub: "sub-1" }, error: null };
            }
            return { data: null, error: new Error("Not found") };
          },
          eq: (_col2: string, val2: string) => ({
            single: async () => {
              if (val1 === "grant-1" && val2 === "u1") {
                return { data: { id: "grant-1", user_id: "u1" }, error: null };
              }
              return { data: null, error: new Error("Not found") };
            },
          }),
        }),
      }),
    }),
  };

  const g1 = await getGrant(mockAdmin, "grant-1");
  assert.equal(g1?.id, "grant-1");

  const g1User = await getGrant(mockAdmin, "grant-1", "u1");
  assert.equal(g1User?.user_id, "u1");

  const gMissing = await getGrant(mockAdmin, "missing");
  assert.equal(gMissing, null);
});

test("grantImpact, removeGrant, listUnusedGrants, deleteUnusedGrant call respective RPCs", async () => {
  const calls: string[] = [];
  const mockAdmin = {
    rpc: async (fn: string, params: any) => {
      calls.push(fn);
      if (fn === "ga4_grant_impact") return { data: 3, error: null };
      if (fn === "ga4_remove_grant") return { data: { removed: true, remainingForGoogleAccount: 0 }, error: null };
      if (fn === "ga4_list_unused_grants") return { data: [{ id: "unused-1", user_id: "u1", google_sub: "s1" }], error: null };
      if (fn === "ga4_delete_unused_grant") return { data: { deleted: true, remainingForGoogleAccount: 0 }, error: null };
      throw new Error(`Unexpected rpc ${fn}`);
    },
  };

  const impact = await grantImpact(mockAdmin, "u1", "g1");
  assert.equal(impact.workspaces, 3);

  const rem = await removeGrant(mockAdmin, "u1", "g1");
  assert.equal(rem.removed, true);

  const unused = await listUnusedGrants(mockAdmin, new Date());
  assert.equal(unused.length, 1);
  assert.equal(unused[0].id, "unused-1");

  const del = await deleteUnusedGrant(mockAdmin, "unused-1", new Date());
  assert.equal(del.deleted, true);

  assert.deepEqual(calls, [
    "ga4_grant_impact",
    "ga4_remove_grant",
    "ga4_list_unused_grants",
    "ga4_delete_unused_grant",
  ]);
});

test("purgeCache: calls ga4_purge_cache and deletes storage files", async () => {
  let purgedStoragePaths: string[] = [];
  const mockAdmin = {
    rpc: async (fn: string, params: any) => {
      if (fn === "ga4_purge_cache") {
        assert.equal(params.p_brand_key, "brand-1");
        return { data: ["path1.json", "path2.json"], error: null };
      }
      throw new Error(`Unexpected rpc ${fn}`);
    },
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, "provider-cache");
        return {
          remove: async (paths: string[]) => {
            purgedStoragePaths = paths;
            return { error: null };
          },
        };
      },
    },
  };

  const paths = await purgeCache(mockAdmin, "brand-1");
  assert.deepEqual(paths, ["path1.json", "path2.json"]);
  assert.deepEqual(purgedStoragePaths, ["path1.json", "path2.json"]);
});
