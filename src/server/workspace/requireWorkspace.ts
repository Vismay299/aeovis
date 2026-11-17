import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";
import { findCustomerBrand } from "../../shared/supabase/customerContext.js";
import { WorkspaceError } from "../../shared/http/errors.ts";
import { enterTelemetryContext } from "../../shared/telemetry/context.ts";

export type CustomerBrand = {
  brandKey: string;
  role: "owner" | "member";
  display_name: string;
  website: string;
  website_host: string;
  aliases: string[];
  is_active: boolean;
};

export type Workspace = {
  user: { id: string; email: string };
  brandKey: string;
  brand: CustomerBrand;
  role: "owner" | "member";
  admin: SupabaseClient;
};

export type CustomerContext = {
  client: SupabaseClient | null;
  user: { id: string; email?: string | null } | null;
  brands: CustomerBrand[];
  error: string | null;
  cause?: unknown;
};

export type RequireWorkspaceDeps = {
  getCustomerContext?: () => Promise<CustomerContext>;
  getSupabaseAdmin?: () => SupabaseClient | null;
};

export async function requireWorkspace(
  request: Request,
  opts?: { brandKey?: string; role?: "owner" | "member" },
  deps?: RequireWorkspaceDeps
): Promise<Workspace> {
  const loadContext =
    deps?.getCustomerContext ??
    (async () => {
      const { getCustomerContext } = await import("../../shared/supabase/customer.js");
      return getCustomerContext() as Promise<CustomerContext>;
    });
  const loadAdmin = deps?.getSupabaseAdmin ?? (() => getSupabaseAdmin());

  const context = await loadContext();

  if (context.error === "auth_not_configured") {
    throw new WorkspaceError(503, "auth_not_configured", "Customer login is not configured.");
  }
  if (!context.user) {
    throw new WorkspaceError(401, "unauthenticated", "Please sign in.");
  }
  if (context.error) {
    throw new WorkspaceError(503, "membership_unavailable", "Could not load workspace access.");
  }

  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("origin");
    const crossSite = request.headers.get("sec-fetch-site") === "cross-site";
    if ((origin && origin !== new URL(request.url).origin) || crossSite) {
      throw new WorkspaceError(403, "cross_site", "Cross-site requests are not allowed.");
    }
  }

  const key =
    opts?.brandKey ||
    new URL(request.url).searchParams.get("brand_key") ||
    context.brands?.[0]?.brandKey ||
    "";
  const brand = findCustomerBrand(context.brands, key) as CustomerBrand | null;
  if (!brand) {
    throw new WorkspaceError(404, "workspace_not_found", "Workspace not found.");
  }
  // Fail closed: any role that is not exactly "owner" is refused, so a role
  // added to the database later cannot inherit owner-only access by default.
  if (opts?.role === "owner" && brand.role !== "owner") {
    throw new WorkspaceError(403, "owner_required", "Only the workspace owner can do this.");
  }

  const admin = loadAdmin();
  if (!admin) {
    throw new WorkspaceError(503, "storage_unavailable", "Workspace storage is unavailable.");
  }

  // Telemetry fallback identity only; auth behaviour unchanged.
  enterTelemetryContext({ userId: context.user.id, brandKey: brand.brandKey });
  return {
    user: { id: context.user.id, email: context.user.email ?? "" },
    brandKey: brand.brandKey,
    brand,
    role: brand.role,
    admin,
  };
}
