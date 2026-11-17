// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/google/googleOAuth.ts:337-423
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { encryptToken, decryptToken } from "../gsc/oauthCrypto.js";
import { getGa4OAuthConfig, type Ga4OAuthConfig } from "./config.ts";
import { Ga4TokenError } from "./errors.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// Refresh when the stored access token is within 60 s of expiry.
export const ACCESS_TOKEN_REFRESH_WINDOW_MS = 60_000;

export const googleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional().default(3600),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

export interface Ga4GrantRow {
  id: string;
  user_id: string;
  google_sub: string;
  google_email?: string | null;
  encrypted_refresh_token?: string | null;
  encrypted_access_token?: string | null;
  access_token_expires_at?: string | Date | null;
  status: "active" | "error";
  last_error?: string | null;
  updated_at: string | Date;
}

export interface TokenDeps {
  config?: Ga4OAuthConfig | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function revokeGoogleToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  });

  // Google answers 400 for an already-revoked or expired token, which counts as revoked.
  if (!response.ok && response.status !== 400) {
    console.error(`[ga4] revoke failed status=${response.status}`);
    throw new Error(`Google token revocation failed: ${response.status}`);
  }
}

export async function getGa4AccessToken(
  admin: any,
  grant: Ga4GrantRow,
  deps?: TokenDeps,
): Promise<string> {
  const now = deps?.now ? deps.now() : Date.now();
  const fetchImpl = deps?.fetchImpl || fetch;
  const config = deps?.config !== undefined ? deps.config : getGa4OAuthConfig();

  const accessAad = `ga4:${grant.user_id}:${grant.google_sub}:access`;
  const refreshAad = `ga4:${grant.user_id}:${grant.google_sub}:refresh`;

  if (grant.status === "error") {
    throw new Ga4TokenError(grant.last_error || "Authorization revoked. Please reconnect.");
  }

  const expiresAt = grant.access_token_expires_at
    ? new Date(grant.access_token_expires_at).getTime()
    : 0;
  const isFresh = expiresAt - now > ACCESS_TOKEN_REFRESH_WINDOW_MS;

  if (isFresh && grant.encrypted_access_token) {
    try {
      const parsed = JSON.parse(grant.encrypted_access_token);
      return decryptToken(parsed, accessAad);
    } catch {
      // Fall through to refresh if access token decryption fails
    }
  }

  if (!grant.encrypted_refresh_token) {
    throw new Ga4TokenError("The Google Analytics grant has expired and cannot be refreshed.");
  }

  if (!config) {
    throw new Error("Google Analytics OAuth is not configured.");
  }

  let refreshTokenPlaintext: string;
  try {
    const parsed = JSON.parse(grant.encrypted_refresh_token);
    refreshTokenPlaintext = decryptToken(parsed, refreshAad);
  } catch (err) {
    throw new Ga4TokenError("Stored refresh token could not be decrypted. Please reconnect.", err);
  }

  const bodyParams = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshTokenPlaintext,
    grant_type: "refresh_token",
  });

  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyParams,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error("[ga4] refresh failed reason=network_error");
    throw new Ga4TokenError("Failed to reach Google to refresh authorization.", err);
  }

  if (!response.ok) {
    let isInvalidGrant = false;
    try {
      const errorJson = await response.json();
      if (errorJson && errorJson.error === "invalid_grant") {
        isInvalidGrant = true;
      }
    } catch {
      // ignore json parse failure
    }

    if (isInvalidGrant || response.status === 400) {
      console.error("[ga4] refresh failed reason=invalid_grant");
      try {
        await admin
          .from("ga4_grants")
          .update({
            status: "error",
            last_error: "Authorization revoked. Please reconnect.",
          })
          .eq("id", grant.id);
      } catch (dbErr) {
        // Log or ignore DB update error
      }
      throw new Ga4TokenError("Authorization revoked. Please reconnect.");
    }

    console.error(`[ga4] refresh failed reason=http_${response.status}`);
    throw new Ga4TokenError(`Google refused to refresh the GA4 grant: HTTP ${response.status}`);
  }

  let tokens: GoogleTokenResponse;
  try {
    const json = await response.json();
    tokens = googleTokenResponseSchema.parse(json);
  } catch (err) {
    console.error("[ga4] refresh failed reason=malformed_response");
    throw new Ga4TokenError("Invalid token response from Google.", err);
  }

  const encryptedAccess = JSON.stringify(encryptToken(tokens.access_token, accessAad));
  const newExpiresAt = new Date(now + (tokens.expires_in ?? 3600) * 1000).toISOString();

  const updateData: Record<string, unknown> = {
    encrypted_access_token: encryptedAccess,
    access_token_expires_at: newExpiresAt,
    status: "active",
    last_error: null,
  };

  if (tokens.refresh_token) {
    updateData.encrypted_refresh_token = JSON.stringify(
      encryptToken(tokens.refresh_token, refreshAad),
    );
  }

  // Conditional update on updated_at so a concurrent refresh never overwrites a newer token
  await admin
    .from("ga4_grants")
    .update(updateData)
    .eq("id", grant.id)
    .eq("updated_at", grant.updated_at);

  return tokens.access_token;
}
