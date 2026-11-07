import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleGa4Callback } from "./oauth.ts";
import { getGa4AccessToken } from "./tokens.ts";
import { removeGoogleAccount } from "./accounts.ts";
import { encryptToken, hashValue } from "../gsc/oauthCrypto.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesDir = path.join(ROOT, "tests/fixtures/f20");
const tokenExchangeJson = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "token-exchange.json"), "utf8"),
);

process.env.GSC_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.GA4_GOOGLE_CLIENT_ID = "privacy-test-client-id";
process.env.GA4_GOOGLE_CLIENT_SECRET = "privacy-test-client-secret";
process.env.GA4_OAUTH_REDIRECT_URI = "https://perceev.xyz/api/customer/ga4/callback";

test("F20-AC-27: Privacy log spy over callback, refresh, and removal paths", async () => {
  const secretStrings = [
    tokenExchangeJson.access_token,
    tokenExchangeJson.refresh_token,
    tokenExchangeJson.id_token,
    "secret-code-xyz-123456",
    "secret-state-nonce-7890",
    "secret-code-verifier-abcdef",
    "sensitive.user@example.com",
  ];

  const loggedMessages: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;

  const spy = (...args: any[]) => {
    loggedMessages.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  };

  console.log = spy;
  console.error = spy;
  console.warn = spy;
  console.info = spy;

  try {
    // 1. Callback path
    const state = "secret-state-nonce-7890";
    const verifier = "secret-code-verifier-abcdef";
    const brandKey = "brand-privacy";
    const userId = "user-privacy";
    const sessionTokenHash = "session-hash-privacy";
    const encVerifier = JSON.stringify(encryptToken(verifier, `ga4:${brandKey}:verifier`));

    const mockAdmin = {
      from: (table: string) => {
        if (table === "ga4_oauth_attempts") {
          return {
            update: () => ({
              eq: () => ({
                is: () => ({
                  gt: () => ({
                    select: () => ({
                      single: async () => ({
                        data: {
                          id: "att-1",
                          user_id: userId,
                          brand_key: brandKey,
                          session_token_hash: sessionTokenHash,
                          encrypted_code_verifier: encVerifier,
                          state_hash: hashValue(state),
                          return_path: "/portal/settings/integrations",
                        },
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "customer_brand_memberships") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: { role: "owner" }, error: null }),
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
      rpc: async (fn: string) => {
        if (fn === "ga4_upsert_grant") return { data: "grant-uuid-priv", error: null };
        throw new Error(`Unexpected rpc: ${fn}`);
      },
    };

    const mockFetch = (async () => {
      return new Response(JSON.stringify(tokenExchangeJson), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const cbUrl = new URL(`https://perceev.xyz/api/customer/ga4/callback?code=secret-code-xyz-123456&state=${state}`);
    await handleGa4Callback({
      admin: mockAdmin,
      url: cbUrl,
      userId,
      sessionTokenHash,
      fetchImpl: mockFetch,
    });

    // 2. Refresh path
    const grant = {
      id: "grant-privacy-1",
      user_id: userId,
      google_sub: "sub-privacy-1",
      encrypted_refresh_token: JSON.stringify(encryptToken("raw-refresh-secret", `ga4:${userId}:sub-privacy-1:refresh`)),
      access_token_expires_at: new Date(Date.now() - 1000).toISOString(),
      status: "active" as const,
      updated_at: new Date().toISOString(),
    };

    const mockAdminRefresh = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      }),
    };

    await getGa4AccessToken(mockAdminRefresh, grant, {
      fetchImpl: mockFetch,
    });

    // 3. Removal path
    const mockAdminRemoval = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  ...grant,
                  encrypted_access_token: JSON.stringify(encryptToken("access-token-to-revoke", `ga4:${userId}:sub-privacy-1:access`)),
                  access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
      rpc: async (fn: string) => {
        if (fn === "ga4_remove_grant") {
          return { data: { removed: true, remainingForGoogleAccount: 0 }, error: null };
        }
        if (fn === "ga4_purge_cache") return { data: [], error: null };
        throw new Error(`Unexpected rpc: ${fn}`);
      },
    };

    const mockRevokeFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

    await removeGoogleAccount(mockAdminRemoval, userId, "grant-privacy-1", {
      fetchImpl: mockRevokeFetch,
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    console.info = originalInfo;
  }

  const allLogs = loggedMessages.join("\n");
  for (const secret of secretStrings) {
    assert.equal(
      allLogs.includes(secret),
      false,
      `Secret leaked in console logs: ${secret}`,
    );
  }
});
