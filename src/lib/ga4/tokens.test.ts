import test from "node:test";
import assert from "node:assert/strict";
import { getGa4AccessToken, revokeGoogleToken } from "./tokens.ts";
import { encryptToken } from "../gsc/oauthCrypto.js";
import { Ga4TokenError } from "./errors.ts";

process.env.GSC_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const MOCK_CONFIG = {
  clientId: "mock-client-id",
  clientSecret: "mock-client-secret",
  redirectUri: "http://localhost:3000/api/customer/ga4/callback",
};

test("getGa4AccessToken: returns fresh access token without network call", async () => {
  const userId = "user-123";
  const googleSub = "sub-456";
  const accessAad = `ga4:${userId}:${googleSub}:access`;
  const rawAccessToken = "ya29.cached-access-token";
  const encAccessToken = JSON.stringify(encryptToken(rawAccessToken, accessAad));

  let fetchCalled = false;
  const mockFetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const now = Date.now();
  const grant = {
    id: "grant-uuid-1",
    user_id: userId,
    google_sub: googleSub,
    encrypted_access_token: encAccessToken,
    access_token_expires_at: new Date(now + 120_000).toISOString(), // 120s in future > 60s refresh window
    status: "active" as const,
    updated_at: new Date(now).toISOString(),
  };

  const token = await getGa4AccessToken({}, grant, {
    config: MOCK_CONFIG,
    fetchImpl: mockFetch,
    now: () => now,
  });

  assert.equal(token, rawAccessToken);
  assert.equal(fetchCalled, false);
});

test("getGa4AccessToken: refreshes token when within 60s of expiry", async () => {
  const userId = "user-123";
  const googleSub = "sub-456";
  const refreshAad = `ga4:${userId}:${googleSub}:refresh`;
  const rawRefreshToken = "1//mock-refresh-token";
  const encRefreshToken = JSON.stringify(encryptToken(rawRefreshToken, refreshAad));

  const now = Date.now();
  let updatedRecord: any = null;
  const mockAdmin = {
    from: (_table: string) => ({
      update: (data: any) => ({
        eq: (col1: string, val1: string) => ({
          eq: (col2: string, val2: string) => {
            updatedRecord = { ...data, col1, val1, col2, val2 };
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  };

  const newAccessToken = "ya29.new-refreshed-access-token";
  let fetchBody: string = "";
  const mockFetch = (async (_url: string, opts: any) => {
    fetchBody = opts.body.toString();
    return new Response(
      JSON.stringify({
        access_token: newAccessToken,
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const grant = {
    id: "grant-uuid-1",
    user_id: userId,
    google_sub: googleSub,
    encrypted_refresh_token: encRefreshToken,
    access_token_expires_at: new Date(now + 30_000).toISOString(), // 30s <= 60s window
    status: "active" as const,
    updated_at: new Date(now - 1000).toISOString(),
  };

  const token = await getGa4AccessToken(mockAdmin, grant, {
    config: MOCK_CONFIG,
    fetchImpl: mockFetch,
    now: () => now,
  });

  assert.equal(token, newAccessToken);
  assert.match(fetchBody, /grant_type=refresh_token/);
  assert.match(fetchBody, /refresh_token=1%2F%2Fmock-refresh-token/);
  assert.ok(updatedRecord);
  assert.equal(updatedRecord.status, "active");
  assert.equal(updatedRecord.val1, grant.id);
  assert.equal(updatedRecord.val2, grant.updated_at);
});

test("getGa4AccessToken: updates refresh token if Google returns a new one", async () => {
  const userId = "user-123";
  const googleSub = "sub-456";
  const refreshAad = `ga4:${userId}:${googleSub}:refresh`;
  const encRefreshToken = JSON.stringify(encryptToken("old-refresh-token", refreshAad));

  const now = Date.now();
  let updatedRecord: any = null;
  const mockAdmin = {
    from: (_table: string) => ({
      update: (data: any) => ({
        eq: (_c1: string, _v1: string) => ({
          eq: (_c2: string, _v2: string) => {
            updatedRecord = data;
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  };

  const mockFetch = (async () => {
    return new Response(
      JSON.stringify({
        access_token: "ya29.new-access-token",
        expires_in: 3600,
        refresh_token: "new-rotated-refresh-token",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const grant = {
    id: "grant-uuid-1",
    user_id: userId,
    google_sub: googleSub,
    encrypted_refresh_token: encRefreshToken,
    access_token_expires_at: null,
    status: "active" as const,
    updated_at: new Date(now).toISOString(),
  };

  await getGa4AccessToken(mockAdmin, grant, {
    config: MOCK_CONFIG,
    fetchImpl: mockFetch,
    now: () => now,
  });

  assert.ok(updatedRecord);
  assert.ok(updatedRecord.encrypted_refresh_token);
});

test("getGa4AccessToken: marks grant status as error when Google returns invalid_grant", async () => {
  const userId = "user-123";
  const googleSub = "sub-456";
  const refreshAad = `ga4:${userId}:${googleSub}:refresh`;
  const encRefreshToken = JSON.stringify(encryptToken("revoked-token", refreshAad));

  let errorRecorded: any = null;
  const mockAdmin = {
    from: (_table: string) => ({
      update: (data: any) => ({
        eq: (_col: string, _val: string) => {
          errorRecorded = data;
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };

  const mockFetch = (async () => {
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const grant = {
    id: "grant-uuid-1",
    user_id: userId,
    google_sub: googleSub,
    encrypted_refresh_token: encRefreshToken,
    status: "active" as const,
    updated_at: new Date().toISOString(),
  };

  await assert.rejects(
    async () => {
      await getGa4AccessToken(mockAdmin, grant, {
        config: MOCK_CONFIG,
        fetchImpl: mockFetch,
      });
    },
    (err: any) => {
      assert.ok(err instanceof Ga4TokenError);
      assert.match(err.message, /Authorization revoked\. Please reconnect\./);
      return true;
    },
  );

  assert.ok(errorRecorded);
  assert.equal(errorRecorded.status, "error");
  assert.equal(errorRecorded.last_error, "Authorization revoked. Please reconnect.");
});

test("getGa4AccessToken: throws immediately if grant is already in error status", async () => {
  const grant = {
    id: "grant-uuid-1",
    user_id: "u1",
    google_sub: "s1",
    status: "error" as const,
    last_error: "Custom error message",
    updated_at: new Date().toISOString(),
  };

  await assert.rejects(
    async () => {
      await getGa4AccessToken({}, grant);
    },
    (err: any) => {
      assert.ok(err instanceof Ga4TokenError);
      assert.equal(err.message, "Custom error message");
      return true;
    },
  );
});

test("revokeGoogleToken: handles 200 and 400 as success, throws on 500", async () => {
  // 200 success
  const mockFetch200 = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  await assert.doesNotReject(async () => {
    await revokeGoogleToken("token-123", mockFetch200);
  });

  // 400 already revoked counts as success
  const mockFetch400 = (async () => new Response("", { status: 400 })) as unknown as typeof fetch;
  await assert.doesNotReject(async () => {
    await revokeGoogleToken("token-123", mockFetch400);
  });

  // 500 server error throws
  const mockFetch500 = (async () => new Response("Server error", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(async () => {
    await revokeGoogleToken("token-123", mockFetch500);
  });
});
