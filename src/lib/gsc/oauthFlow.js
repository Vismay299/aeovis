import { encryptToken, decryptToken, hashValue, generateSecureRandom } from "./oauthCrypto.js";

/**
 * Google Search Console OAuth 2.0 web-server flow.
 *
 * Uses authorization-code grant with offline access for background refresh.
 * One platform OAuth app serves all customers; each workspace stores its own
 * encrypted credentials.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const ATTEMPT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getConfig() {
  const clientId = (process.env.GSC_GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GSC_GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = (process.env.GSC_OAUTH_REDIRECT_URI || "").trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isGscOAuthConfigured() {
  return !!getConfig();
}

/**
 * Build the Google authorization URL and create a short-lived attempt record.
 *
 * @param {object} params
 * @param {string} params.userId - Supabase auth user ID
 * @param {string} params.brandKey - workspace brand key
 * @param {string} params.sessionTokenHash - hash of the current session token for binding
 * @param {object} params.admin - Supabase admin client
 * @returns {Promise<{ authorizationUrl: string, state: string }>}
 */
export async function createOAuthAttempt({ userId, brandKey, sessionTokenHash, admin }) {
  const config = getConfig();
  if (!config) throw new Error("GSC OAuth is not configured on this deployment.");

  const state = generateSecureRandom(32);
  const codeVerifier = generateSecureRandom(32); // PKCE S256
  const codeChallenge = await pkceChallenge(codeVerifier);
  const stateHash = hashValue(state);

  // Store the attempt. Encrypt the code verifier and store its hash.
  const encryptedVerifier = encryptToken(codeVerifier, `${brandKey}:verifier`);

  const { error } = await admin.from("gsc_oauth_attempts").insert({
    user_id: userId,
    brand_key: brandKey,
    state_hash: stateHash,
    session_token_hash: sessionTokenHash || null,
    encrypted_code_verifier: JSON.stringify(encryptedVerifier),
    expires_at: new Date(Date.now() + ATTEMPT_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`Failed to create OAuth attempt: ${error.message}`);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GSC_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    authorizationUrl: `${GOOGLE_AUTH_URL}?${params}`,
    state,
  };
}

/**
 * Handle the OAuth callback: validate state, exchange code, store credentials.
 *
 * @param {object} params
 * @param {string} params.state - raw state from callback
 * @param {string} params.code - authorization code from callback
 * @param {string} params.sessionTokenHash - hash of the current session
 * @param {object} params.admin - Supabase admin client
 * @returns {Promise<{ brandKey: string, userId: string }>}
 */
export async function handleOAuthCallback({ state, code, sessionTokenHash, admin }) {
  const config = getConfig();
  if (!config) throw new Error("GSC OAuth is not configured on this deployment.");
  if (!state || !code) throw new Error("Missing state or code in OAuth callback.");

  const stateHash = hashValue(state);

  // Find and consume the attempt.
  const { data: attempts, error: findError } = await admin
    .from("gsc_oauth_attempts")
    .select("*")
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .limit(1);

  if (findError) throw new Error(`Failed to validate OAuth attempt: ${findError.message}`);
  const attempt = attempts?.[0];
  if (!attempt) throw new Error("This authorization attempt is invalid, expired, or already used.");

  // Validate session binding.
  if (attempt.session_token_hash && sessionTokenHash && attempt.session_token_hash !== sessionTokenHash) {
    throw new Error("This authorization attempt was started from a different session.");
  }

  // Consume the attempt.
  const { error: consumeError } = await admin
    .from("gsc_oauth_attempts")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", attempt.id);
  if (consumeError) console.error("[gsc-oauth] failed to consume attempt:", consumeError);

  // Decrypt the code verifier for PKCE.
  let codeVerifier = null;
  if (attempt.encrypted_code_verifier) {
    try {
      const parsed = JSON.parse(attempt.encrypted_code_verifier);
      codeVerifier = decryptToken(parsed, `${attempt.brand_key}:verifier`);
    } catch { /* non-fatal, PKCE verifier may not be required by Google */ }
  }

  // Exchange the authorization code for tokens.
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (codeVerifier) tokenBody.set("code_verifier", codeVerifier);

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });

  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text().catch(() => "");
    throw new Error(`Token exchange failed: HTTP ${tokenResponse.status} — ${errBody.slice(0, 200)}`);
  }

  const tokens = await tokenResponse.json();
  if (!tokens.access_token) throw new Error("Token exchange returned no access token.");

  // Encrypt and store credentials.
  const aad = `${attempt.brand_key}:${attempt.user_id}`;
  const encryptedRefresh = tokens.refresh_token
    ? JSON.stringify(encryptToken(tokens.refresh_token, `${aad}:refresh`))
    : null;
  const encryptedAccess = tokens.access_token
    ? JSON.stringify(encryptToken(tokens.access_token, `${aad}:access`))
    : null;

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  // Upsert credentials (one per workspace).
  const { error: credError } = await admin
    .from("gsc_oauth_credentials")
    .upsert({
      brand_key: attempt.brand_key,
      authorizing_user_id: attempt.user_id,
      encrypted_refresh_token: encryptedRefresh,
      encrypted_access_token: encryptedAccess,
      access_token_expires_at: expiresAt,
      scopes: [GSC_SCOPE],
      key_version: 1,
      status: "active",
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "brand_key" });

  if (credError) throw new Error(`Failed to store credentials: ${credError.message}`);

  // Get the credential ID for the pending grant.
  const { data: credRow } = await admin
    .from("gsc_oauth_credentials")
    .select("id")
    .eq("brand_key", attempt.brand_key)
    .single();

  return {
    brandKey: attempt.brand_key,
    userId: attempt.user_id,
    credentialId: credRow?.id,
  };
}

/**
 * List GSC properties accessible through a workspace's OAuth credentials.
 *
 * @param {object} params
 * @param {string} params.brandKey
 * @param {object} params.admin
 * @returns {Promise<Array<{ siteUrl: string, permissionLevel: string }>>}
 */
export async function listOAuthProperties({ brandKey, admin }) {
  const accessToken = await getValidAccessToken({ brandKey, admin });
  const response = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      await markCredentialError(brandKey, admin, "Authorization expired or revoked. Please reconnect.");
      throw new Error("Google authorization expired. Please reconnect.");
    }
    throw new Error(`Failed to list GSC properties: HTTP ${response.status} — ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return (data.siteEntry || []).map((s) => ({
    siteUrl: s.siteUrl,
    permissionLevel: s.permissionLevel,
  }));
}

/**
 * Get a valid access token for a workspace, refreshing if needed.
 *
 * @param {object} params
 * @param {string} params.brandKey
 * @param {object} params.admin
 * @returns {Promise<string>}
 */
export async function getValidAccessToken({ brandKey, admin }) {
  const { data: cred, error } = await admin
    .from("gsc_oauth_credentials")
    .select("*")
    .eq("brand_key", brandKey)
    .eq("status", "active")
    .single();

  if (error || !cred) throw new Error("No active Google authorization for this workspace.");

  const aad = `${brandKey}:${cred.authorizing_user_id}`;

  // Try cached access token first.
  if (cred.encrypted_access_token && cred.access_token_expires_at) {
    const expiresAt = new Date(cred.access_token_expires_at).getTime();
    if (expiresAt > Date.now() + 60_000) {
      try {
        return decryptToken(JSON.parse(cred.encrypted_access_token), `${aad}:access`);
      } catch { /* fall through to refresh */ }
    }
  }

  // Refresh using the refresh token.
  if (!cred.encrypted_refresh_token) {
    await markCredentialError(brandKey, admin, "No refresh token available. Please reconnect with consent.");
    throw new Error("No refresh token. Please reconnect Google Search Console.");
  }

  let refreshToken;
  try {
    refreshToken = decryptToken(JSON.parse(cred.encrypted_refresh_token), `${aad}:refresh`);
  } catch {
    await markCredentialError(brandKey, admin, "Credential decryption failed.");
    throw new Error("Credential decryption failed. Please reconnect Google Search Console.");
  }

  const config = getConfig();
  if (!config) throw new Error("GSC OAuth is not configured.");

  const refreshResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  if (!refreshResponse.ok) {
    const errBody = await refreshResponse.text().catch(() => "");
    if (errBody.includes("invalid_grant")) {
      await markCredentialError(brandKey, admin, "Authorization revoked. Please reconnect.");
      throw new Error("Google authorization was revoked. Please reconnect.");
    }
    throw new Error(`Token refresh failed: HTTP ${refreshResponse.status}`);
  }

  const newTokens = await refreshResponse.json();
  const newExpiresAt = newTokens.expires_in
    ? new Date(Date.now() + newTokens.expires_in * 1000).toISOString()
    : null;

  // Update stored access token (and refresh token if Google provided a new one).
  const update = {
    encrypted_access_token: JSON.stringify(encryptToken(newTokens.access_token, `${aad}:access`)),
    access_token_expires_at: newExpiresAt,
    status: "active",
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  if (newTokens.refresh_token) {
    update.encrypted_refresh_token = JSON.stringify(encryptToken(newTokens.refresh_token, `${aad}:refresh`));
  }

  await admin.from("gsc_oauth_credentials").update(update).eq("id", cred.id);
  return newTokens.access_token;
}

/**
 * Disconnect GSC for a workspace: delete credentials and disable the connection.
 */
export async function disconnectGsc({ brandKey, admin }) {
  // Delete credentials.
  await admin.from("gsc_oauth_credentials").delete().eq("brand_key", brandKey);

  // Disable the connection and invalidate generation.
  const { data: conn } = await admin
    .from("gsc_connections")
    .select("connection_generation")
    .eq("brand_key", brandKey)
    .single();

  const newGen = (conn?.connection_generation || 0) + 1;

  await admin.from("gsc_connections")
    .update({
      enabled: false,
      auth_mode: null,
      credential_id: null,
      connection_generation: newGen,
      last_status: null,
      last_error: "Disconnected by owner",
      updated_at: new Date().toISOString(),
    })
    .eq("brand_key", brandKey);

  // Cancel pending sync jobs.
  await admin.from("gsc_sync_jobs")
    .update({ status: "cancelled" })
    .eq("brand_key", brandKey)
    .in("status", ["pending", "running"]);

  return { disconnected: true, generation: newGen };
}

async function markCredentialError(brandKey, admin, message) {
  await admin.from("gsc_oauth_credentials")
    .update({ status: "error", last_error: message, updated_at: new Date().toISOString() })
    .eq("brand_key", brandKey);
}

// PKCE S256 challenge generation.
async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}