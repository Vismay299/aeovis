// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/google/googleOAuth.ts
// Patterned after Perceev's src/server/gsc/oauthFlow.js.
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import crypto from "node:crypto";
import {
  GA4_DATA_SCOPE,
  GA4_LINK_ERROR_PARAM,
  GA4_OAUTH_SCOPES,
  type Ga4LinkErrorCode,
  type Ga4ReturnPath,
} from "../../shared/ga4.ts";
import {
  encryptToken,
  decryptToken,
  hashValue,
  generateSecureRandom,
} from "../gsc/oauthCrypto.js";
import { AppError } from "../../shared/http/errors.ts";
import { getGa4OAuthConfig, isGa4Configured, type Ga4OAuthConfig } from "./config.ts";
import { readIdTokenClaims, type IdTokenClaims } from "./idToken.ts";
import { upsertGrant } from "./grants.ts";
import { googleTokenResponseSchema, type GoogleTokenResponse } from "./tokens.ts";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface CreateAuthUrlInput {
  admin: any;
  userId: string;
  brandKey: string;
  sessionTokenHash: string;
  returnPath?: string;
  now?: () => number;
}

export interface HandleCallbackInput {
  admin: any;
  url: string | URL;
  userId: string | null;
  sessionTokenHash: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface HandleCallbackResult {
  redirect: string;
  outcome: "linked" | Ga4LinkErrorCode;
}

function buildRedirect(basePath: string, key: string, value: string): string {
  const url = new URL(basePath, "https://perceev.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function createGa4AuthorizationUrl(
  input: CreateAuthUrlInput,
): Promise<{ authorizationUrl: string }> {
  if (!isGa4Configured()) {
    throw new AppError(
      503,
      "ga4_not_configured",
      "Google Analytics isn't set up on this deployment yet.",
    );
  }

  const config = getGa4OAuthConfig()!;
  const returnPath = input.returnPath || "/portal/settings/integrations";

  const state = generateSecureRandom(32);
  const stateHash = hashValue(state);

  const codeVerifier = generateSecureRandom(32);
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const verifierAad = `ga4:${input.brandKey}:verifier`;
  const encryptedVerifier = JSON.stringify(encryptToken(codeVerifier, verifierAad));

  const nowMs = input.now ? input.now() : Date.now();
  const expiresAt = new Date(nowMs + 10 * 60 * 1000).toISOString();

  const { error } = await input.admin.from("ga4_oauth_attempts").insert({
    user_id: input.userId,
    brand_key: input.brandKey,
    state_hash: stateHash,
    session_token_hash: input.sessionTokenHash,
    encrypted_code_verifier: encryptedVerifier,
    return_path: returnPath,
    expires_at: expiresAt,
  });

  if (error) {
    throw new Error(`Failed to create GA4 OAuth attempt: ${error.message}`);
  }

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GA4_OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Explicitly NO include_granted_scopes per F20-AC-01

  return { authorizationUrl: url.toString() };
}

export async function exchangeCode(input: {
  code: string;
  codeVerifier: string;
  config: Ga4OAuthConfig;
  fetchImpl?: typeof fetch;
}): Promise<GoogleTokenResponse | null> {
  const fetchImpl = input.fetchImpl || fetch;
  const body = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.config.redirectUri,
    code_verifier: input.codeVerifier,
  });

  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  try {
    const json = await res.json();
    return googleTokenResponseSchema.parse(json);
  } catch {
    return null;
  }
}

export async function handleGa4Callback(
  input: HandleCallbackInput,
): Promise<HandleCallbackResult> {
  const defaultReturnPath = "/portal/settings/integrations";
  const nowMs = input.now ? input.now() : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // (1) No session -> redirect to login
  if (!input.userId || !input.sessionTokenHash) {
    return {
      redirect: `/login?next=${encodeURIComponent(defaultReturnPath)}`,
      outcome: "state_mismatch",
    };
  }

  const parsedUrl = typeof input.url === "string" ? new URL(input.url, "https://perceev.local") : input.url;
  const rawState = parsedUrl.searchParams.get("state");

  // (2) state missing
  if (!rawState) {
    console.error("[ga4] link outcome=state_mismatch");
    return {
      redirect: buildRedirect(defaultReturnPath, GA4_LINK_ERROR_PARAM, "state_mismatch"),
      outcome: "state_mismatch",
    };
  }

  const stateHash = hashValue(rawState);

  // (3) Compare-and-set consumed_at (single use, replay-proof)
  const { data: attempt, error: attemptErr } = await input.admin
    .from("ga4_oauth_attempts")
    .update({ consumed_at: nowIso })
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .select()
    .single();

  if (attemptErr || !attempt) {
    console.error("[ga4] link outcome=state_mismatch");
    return {
      redirect: buildRedirect(defaultReturnPath, GA4_LINK_ERROR_PARAM, "state_mismatch"),
      outcome: "state_mismatch",
    };
  }

  const returnPath = attempt.return_path || defaultReturnPath;

  const fail = (code: Ga4LinkErrorCode): HandleCallbackResult => {
    console.error(`[ga4] link outcome=${code}`);
    return {
      redirect: buildRedirect(returnPath, GA4_LINK_ERROR_PARAM, code),
      outcome: code,
    };
  };

  // (4) Attempt belongs to current user and session token matches
  if (attempt.user_id !== input.userId || attempt.session_token_hash !== input.sessionTokenHash) {
    return fail("state_mismatch");
  }

  // (5) Membership role check: must be owner
  const { data: membership, error: memErr } = await input.admin
    .from("customer_brand_memberships")
    .select("role")
    .eq("brand_key", attempt.brand_key)
    .eq("user_id", input.userId)
    .single();

  if (memErr || !membership || membership.role !== "owner") {
    return fail("owner_required");
  }

  // (6) Google error or missing code
  const googleError = parsedUrl.searchParams.get("error");
  if (googleError) {
    const mapped = googleError === "access_denied" ? "access_denied" : "oauth_failed";
    return fail(mapped);
  }

  const code = parsedUrl.searchParams.get("code");
  if (!code) {
    return fail("missing_code");
  }

  const config = getGa4OAuthConfig();
  if (!config) {
    return fail("oauth_code_verification_failed");
  }

  // (7) Token exchange with PKCE verifier
  let codeVerifier: string;
  try {
    const verifierAad = `ga4:${attempt.brand_key}:verifier`;
    const parsed = JSON.parse(attempt.encrypted_code_verifier);
    codeVerifier = decryptToken(parsed, verifierAad);
  } catch {
    return fail("oauth_code_verification_failed");
  }

  const tokens = await exchangeCode({
    code,
    codeVerifier,
    config,
    fetchImpl: input.fetchImpl,
  });

  if (!tokens) {
    return fail("oauth_code_verification_failed");
  }

  // (8) Check scope: must include GA4_DATA_SCOPE
  if (tokens.scope) {
    const grantedScopes = tokens.scope.split(/\s+/);
    if (!grantedScopes.includes(GA4_DATA_SCOPE)) {
      return fail("scope_not_granted");
    }
  }

  // (9) Validate id_token claims
  let claims: IdTokenClaims;
  try {
    claims = readIdTokenClaims(tokens.id_token || "", config.clientId, nowMs);
  } catch {
    return fail("oauth_code_verification_failed");
  }

  // (10) Encrypt tokens and upsert grant
  try {
    const scopesList = tokens.scope ? tokens.scope.trim().split(/\s+/) : [...GA4_OAUTH_SCOPES];
    const expiresAt = new Date(nowMs + (tokens.expires_in ?? 3600) * 1000);

    await upsertGrant(input.admin, {
      userId: input.userId,
      googleSub: claims.sub,
      googleEmail: claims.email,
      refreshToken: tokens.refresh_token || null,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: expiresAt,
      scopes: scopesList,
    });
  } catch {
    return fail("connection_save_failed");
  }

  // (11) Success
  console.log("[ga4] link outcome=linked");
  return {
    redirect: buildRedirect(returnPath, "ga4", "linked"),
    outcome: "linked",
  };
}
