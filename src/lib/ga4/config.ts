// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/google/oauth-config.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { isEncryptionConfigured } from "../gsc/oauthCrypto.js";

export interface Ga4OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGa4OAuthConfig(env: NodeJS.ProcessEnv = process.env): Ga4OAuthConfig | null {
  const clientId = (env.GA4_GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (env.GA4_GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = (env.GA4_OAUTH_REDIRECT_URI || "").trim();

  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isGa4Configured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getGa4OAuthConfig(env) && isEncryptionConfigured());
}
