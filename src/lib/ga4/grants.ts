// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/google/GoogleAccountRepository.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { encryptToken } from "../gsc/oauthCrypto.js";

export interface UpsertGrantInput {
  userId: string;
  googleSub: string;
  googleEmail?: string | null;
  refreshToken?: string | null;
  accessToken?: string | null;
  accessTokenExpiresAt?: string | Date | null;
  scopes?: string[];
}

export interface Ga4GrantSummary {
  grantId: string;
  email: string | null;
  status: "active" | "error";
  linkedAt: string;
  workspaces: number;
}

export interface RemoveGrantResult {
  removed: boolean;
  googleSub?: string;
  brands?: string[];
  remainingForGoogleAccount?: number;
}

export interface DeleteUnusedGrantResult {
  deleted: boolean;
  remainingForGoogleAccount?: number;
}

export async function upsertGrant(
  admin: any,
  input: UpsertGrantInput,
): Promise<string> {
  const refreshAad = `ga4:${input.userId}:${input.googleSub}:refresh`;
  const accessAad = `ga4:${input.userId}:${input.googleSub}:access`;

  const encRefreshToken = input.refreshToken
    ? JSON.stringify(encryptToken(input.refreshToken, refreshAad))
    : null;
  const encAccessToken = input.accessToken
    ? JSON.stringify(encryptToken(input.accessToken, accessAad))
    : null;

  const expiresIso = input.accessTokenExpiresAt
    ? (typeof input.accessTokenExpiresAt === "string"
        ? input.accessTokenExpiresAt
        : input.accessTokenExpiresAt.toISOString())
    : null;

  const { data, error } = await admin.rpc("ga4_upsert_grant", {
    p_user_id: input.userId,
    p_google_sub: input.googleSub,
    p_google_email: input.googleEmail || null,
    p_encrypted_refresh_token: encRefreshToken,
    p_encrypted_access_token: encAccessToken,
    p_access_token_expires_at: expiresIso,
    p_scopes: input.scopes || [],
  });

  if (error) {
    throw new Error(`Failed to upsert GA4 grant: ${error.message}`);
  }

  return data;
}

export async function listGrantsForUser(
  admin: any,
  userId: string,
): Promise<Ga4GrantSummary[]> {
  const { data: grants, error } = await admin
    .from("ga4_grants")
    .select("id, google_sub, google_email, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to list GA4 grants: ${error.message}`);
  }

  if (!grants || grants.length === 0) {
    return [];
  }

  const { data: connections } = await admin
    .from("ga4_connections")
    .select("grant_id");

  const usageCounts = new Map<string, number>();
  if (connections) {
    for (const c of connections) {
      if (c.grant_id) {
        usageCounts.set(c.grant_id, (usageCounts.get(c.grant_id) || 0) + 1);
      }
    }
  }

  return grants.map((g: any) => ({
    grantId: g.id,
    email: g.google_email || null,
    status: g.status,
    linkedAt: g.created_at,
    workspaces: usageCounts.get(g.id) || 0,
  }));
}

export async function getGrant(
  admin: any,
  grantId: string,
  userId?: string,
): Promise<any> {
  let query = admin.from("ga4_grants").select("*").eq("id", grantId);
  if (userId) {
    query = query.eq("user_id", userId);
  }
  const { data, error } = await query.single();
  if (error) {
    return null;
  }
  return data;
}

export async function grantImpact(
  admin: any,
  userId: string,
  grantId: string,
): Promise<{ workspaces: number }> {
  const { data, error } = await admin.rpc("ga4_grant_impact", {
    p_user_id: userId,
    p_grant_id: grantId,
  });
  if (error) {
    throw new Error(`Failed to check grant impact: ${error.message}`);
  }
  return { workspaces: Number(data) || 0 };
}

export async function removeGrant(
  admin: any,
  userId: string,
  grantId: string,
): Promise<RemoveGrantResult> {
  const { data, error } = await admin.rpc("ga4_remove_grant", {
    p_user_id: userId,
    p_grant_id: grantId,
  });
  if (error) {
    throw new Error(`Failed to remove GA4 grant: ${error.message}`);
  }
  return data as RemoveGrantResult;
}

export async function listUnusedGrants(
  admin: any,
  updatedBefore: Date,
  limit: number = 50,
): Promise<Array<{ id: string; user_id: string; google_sub: string }>> {
  const { data, error } = await admin.rpc("ga4_list_unused_grants", {
    p_updated_before: updatedBefore.toISOString(),
    p_limit: limit,
  });
  if (error) {
    throw new Error(`Failed to list unused GA4 grants: ${error.message}`);
  }
  return data || [];
}

export async function deleteUnusedGrant(
  admin: any,
  grantId: string,
  updatedBefore: Date,
): Promise<DeleteUnusedGrantResult> {
  const { data, error } = await admin.rpc("ga4_delete_unused_grant", {
    p_id: grantId,
    p_updated_before: updatedBefore.toISOString(),
  });
  if (error) {
    throw new Error(`Failed to delete unused GA4 grant: ${error.message}`);
  }
  return data as DeleteUnusedGrantResult;
}

export async function purgeCache(
  admin: any,
  brandKey: string,
): Promise<string[]> {
  const { data, error } = await admin.rpc("ga4_purge_cache", {
    p_brand_key: brandKey,
  });
  if (error) {
    throw new Error(`Failed to purge GA4 cache: ${error.message}`);
  }

  const paths: string[] = (data || []).filter(Boolean);
  if (paths.length > 0 && admin.storage) {
    try {
      await admin.storage.from("provider-cache").remove(paths);
    } catch {
      // Storage cleanup failure does not block cache table purge
    }
  }

  return paths;
}
