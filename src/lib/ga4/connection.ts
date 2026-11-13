// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4Service.ts
//   src/server/features/ga4/repositories/Ga4ConnectionRepository.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { isGa4Configured } from "./config.ts";
import { getGrant, listGrantsForUser } from "./grants.ts";
import { purgeCache } from "./grants.ts";
import { getGa4AccessToken, type TokenDeps } from "./tokens.ts";
import { createGa4AdminClient } from "./client.ts";
import { Ga4TokenError } from "./errors.ts";
import { AppError } from "../http/appError.ts";

function brandKeyOf(ws: unknown): string {
  if (typeof ws === "string") return ws;
  if (ws && typeof ws === "object") {
    const o = ws as Record<string, unknown>;
    if (typeof o.brandKey === "string") return o.brandKey;
    if (typeof o.brand_key === "string") return o.brand_key;
  }
  return "";
}

export interface Ga4ConnectionRow {
  brand_key: string;
  grant_id: string;
  connected_by: string;
  google_sub: string;
  connected_account_email: string | null;
  property_id: string;
  property_display_name: string;
  property_time_zone: string;
  property_currency_code: string;
  account_display_name: string | null;
  created_at: string;
  updated_at: string;
  connected_at?: string;
}

export interface ConnectionDeps extends TokenDeps {}

export async function getConnection(admin: any, brandKeyOrWs: unknown): Promise<Ga4ConnectionRow | null> {
  const brandKey = brandKeyOf(brandKeyOrWs) || (typeof brandKeyOrWs === "string" ? brandKeyOrWs : "");
  const { data, error } = await admin
    .from("ga4_connections")
    .select("*")
    .eq("brand_key", brandKey)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load GA4 connection: ${error.message}`);
  }
  return (data as Ga4ConnectionRow) || null;
}

export async function getGa4ConnectionState(admin: any, ws: unknown, deps?: ConnectionDeps): Promise<any> {
  const brandKey = brandKeyOf(ws);
  const configured = isGa4Configured();
  const role = (ws && typeof ws === "object" ? (ws as any).role : undefined) || "member";
  const canManage = role === "owner";

  let currentUserHasGrant = false;
  const userId = ws && typeof ws === "object" ? (ws as any).user?.id : undefined;
  if (userId) {
    try {
      const grants = await listGrantsForUser(admin, userId);
      currentUserHasGrant = grants.length > 0;
    } catch {
      currentUserHasGrant = false;
    }
  }

  const conn = await getConnection(admin, brandKey);

  if (!conn) {
    return {
      connected: false,
      configured,
      canManage,
      currentUserHasGrant,
      connectorIsMember: false,
      grantStatus: null,
      property: null,
      connectedByEmail: null,
      connectedAt: null,
    };
  }

  // connector membership
  let connectorIsMember = false;
  if (conn.connected_by) {
    const { data: member } = await admin
      .from("customer_brand_memberships")
      .select("role")
      .eq("brand_key", brandKey)
      .eq("user_id", conn.connected_by)
      .maybeSingle();
    connectorIsMember = Boolean(member);
  }

  let grantStatus: "active" | "error" | null = null;
  if (conn.grant_id) {
    const grant = await getGrant(admin, conn.grant_id);
    if (grant) grantStatus = grant.status;
  }

  return {
    connected: true,
    configured,
    canManage,
    currentUserHasGrant,
    connectorIsMember,
    grantStatus,
    property: {
      id: conn.property_id,
      displayName: conn.property_display_name,
      timeZone: conn.property_time_zone,
      currencyCode: conn.property_currency_code,
      accountDisplayName: conn.account_display_name,
    },
    connectedByEmail: conn.connected_account_email || null,
    connectedAt: conn.connected_at || conn.created_at,
  };
}

export async function listPropertiesForUser(
  admin: any,
  userId: string,
  selectedPropertyId?: string,
  deps?: ConnectionDeps,
): Promise<{ accounts: any[] }> {
  const grants = await listGrantsForUser(admin, userId);
  const accounts = await Promise.all(
    grants.map(async (grant: any) => {
      // We need the full grant row to mint a token. Fetch it.
      const fullGrant = await getGrant(admin, grant.grantId, userId);
      const client = fullGrant
        ? createGa4AdminClient({
            getToken: async () => getGa4AccessToken(admin, fullGrant, deps),
            fetchImpl: deps?.fetchImpl,
          })
        : null;

      if (!client) {
        return {
          grantId: grant.grantId,
          email: grant.email,
          requiresReconnect: true,
          propertiesUnavailable: false,
          properties: [],
        };
      }

      try {
        const props = await client.listProperties();
        let email: string | null = grant.email;
        try {
          const fetchedEmail = await client.getUserInfoEmail();
          if (fetchedEmail) email = fetchedEmail;
        } catch {
          // keep grant email
        }
        return {
          grantId: grant.grantId,
          email,
          requiresReconnect: false,
          propertiesUnavailable: false,
          properties: props.map((p: any) => ({
            propertyId: p.propertyId,
            displayName: p.displayName,
            accountDisplayName: p.accountDisplayName,
            isSelected: selectedPropertyId === p.propertyId,
          })),
        };
      } catch (err) {
        const isToken = err instanceof Ga4TokenError;
        const is401 = err instanceof Error && (err as any).status === 401;
        const reconnect = isToken || is401;
        return {
          grantId: grant.grantId,
          email: null,
          requiresReconnect: reconnect,
          propertiesUnavailable: !reconnect,
          properties: [],
        };
      }
    }),
  );
  return { accounts };
}

export async function setProperty(
  admin: any,
  ws: unknown,
  input: { grantId: string; propertyId: string },
  deps?: ConnectionDeps,
): Promise<Ga4ConnectionRow> {
  const brandKey = brandKeyOf(ws);
  const userId = (ws && typeof ws === "object" ? (ws as any).user?.id : undefined) || "";

  // owner check
  if (ws && typeof ws === "object" && (ws as any).role && (ws as any).role !== "owner") {
    throw new AppError(403, "owner_required", "Only the workspace owner can manage Google Analytics.");
  }
  // membership check (owner)
  const { data: member } = await admin
    .from("customer_brand_memberships")
    .select("role")
    .eq("brand_key", brandKey)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member || member.role !== "owner") {
    throw new AppError(403, "owner_required", "Only the workspace owner can manage Google Analytics.");
  }

  const grant = await getGrant(admin, input.grantId, userId);
  if (!grant || grant.status !== "active") {
    throw new AppError(404, "ga4_grant_not_found", "That Google account isn't linked to your Perceev account.");
  }

  const client = createGa4AdminClient({
    getToken: async () => getGa4AccessToken(admin, grant, deps),
    fetchImpl: deps?.fetchImpl,
  });

  const props = await client.listProperties();
  if (!props.some((p: any) => p.propertyId === input.propertyId)) {
    throw new AppError(404, "ga4_property_not_found", "That Google Analytics property isn't available on your linked Google account.");
  }

  const property = await client.getProperty(input.propertyId);

  let connectedAccountEmail: string | null = grant.google_email || null;
  try {
    const email = await client.getUserInfoEmail();
    if (email) connectedAccountEmail = email;
  } catch {
    // keep grant email
  }

  // call RPC
  const { data, error } = await admin.rpc("ga4_set_connection", {
    p_brand_key: brandKey,
    p_user_id: userId,
    p_grant_id: input.grantId,
    p_property_id: property.name,
    p_property_display_name: property.displayName,
    p_property_time_zone: property.timeZone,
    p_property_currency_code: property.currencyCode,
    p_account_display_name: null,
  });
  if (error) {
    if (error.message?.includes("owner_required")) {
      throw new AppError(403, "owner_required", "Only the workspace owner can manage Google Analytics.");
    }
    if (error.message?.includes("ga4_grant_not_found")) {
      throw new AppError(404, "ga4_grant_not_found", "That Google account isn't linked to your Perceev account.");
    }
    if (error.message?.includes("ga4_property_not_found")) {
      throw new AppError(404, "ga4_property_not_found", "That Google Analytics property isn't available on your linked Google account.");
    }
    throw new Error(`Failed to set GA4 connection: ${error.message}`);
  }

  // purge cache
  try {
    await purgeCache(admin, brandKey);
  } catch {
    // ignore
  }

  // update grant updated_at already in RPC; fetch connection
  const conn = await getConnection(admin, brandKey);
  return conn as Ga4ConnectionRow;
}

export async function disconnect(admin: any, ws: unknown, deps?: ConnectionDeps): Promise<boolean> {
  const brandKey = brandKeyOf(ws);
  const userId = (ws && typeof ws === "object" ? (ws as any).user?.id : undefined) || "";

  // owner check
  const { data: member } = await admin
    .from("customer_brand_memberships")
    .select("role")
    .eq("brand_key", brandKey)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member || member.role !== "owner") {
    throw new AppError(403, "owner_required", "Only the workspace owner can manage Google Analytics.");
  }

  const { data, error } = await admin.rpc("ga4_disconnect", {
    p_brand_key: brandKey,
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`Failed to disconnect GA4: ${error.message}`);
  }

  try {
    await purgeCache(admin, brandKey);
  } catch {
    // ignore
  }

  return Boolean(data);
}

export async function requireUsableConnection(admin: any, brandKeyOrWs: unknown): Promise<Ga4ConnectionRow> {
  const brandKey = typeof brandKeyOrWs === "string" ? brandKeyOrWs : brandKeyOf(brandKeyOrWs);
  const conn = await getConnection(admin, brandKey);
  if (!conn) {
    throw new AppError(409, "ga4_not_connected", "Google Analytics isn't connected for this workspace.");
  }

  // connector membership
  let connectorIsMember = false;
  if (conn.connected_by) {
    const { data: member } = await admin
      .from("customer_brand_memberships")
      .select("role")
      .eq("brand_key", brandKey)
      .eq("user_id", conn.connected_by)
      .maybeSingle();
    connectorIsMember = Boolean(member);
  }

  let grantStatus: string | null = null;
  if (conn.grant_id) {
    const grant = await getGrant(admin, conn.grant_id);
    if (grant) grantStatus = grant.status;
  }

  if (!connectorIsMember || grantStatus === "error") {
    const msg = !connectorIsMember
      ? "The person who connected Google Analytics is no longer in this workspace."
      : "The Google Analytics connection has expired or was revoked.";
    throw new AppError(409, "ga4_reconnect_required", msg);
  }

  return conn;
}
