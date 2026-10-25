import type { SupabaseClient, User } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";
import { enterTelemetryContext } from "../telemetry/context.ts";

export type RequireUserResult = {
  user: { id: string; email: string | null };
  admin: SupabaseClient;
};

type CustomerClient = {
  auth: {
    getUser: () => Promise<{ data: { user: User | null }; error: unknown }>;
  };
};

export type RequireUserDeps = {
  createClient?: () => CustomerClient | null | Promise<CustomerClient | null>;
  getSupabaseAdmin?: () => SupabaseClient | null;
};

/**
 * Signed-in user without a workspace requirement (F25/F26 privacy and similar).
 * Enters the telemetry context with brandKey null.
 *
 * Customer SSR client is loaded lazily so unit tests that inject createClient
 * never pull in `next/headers`.
 */
export async function requireUser(
  _request?: Request,
  deps?: RequireUserDeps,
): Promise<RequireUserResult> {
  let client: CustomerClient | null = null;
  if (deps?.createClient) {
    client = await deps.createClient();
  } else {
    const mod = await import("../supabase/customer.js");
    client = (await mod.createCustomerSupabaseClient()) as CustomerClient | null;
  }

  if (!client) {
    throw new AppError(503, "auth_not_configured", "Authentication is not configured.");
  }

  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) {
    throw new AppError(401, "unauthenticated", "Sign in to continue.");
  }

  let admin: SupabaseClient | null = null;
  if (deps?.getSupabaseAdmin) {
    admin = deps.getSupabaseAdmin();
  } else {
    const mod = await import("../supabase/admin.js");
    admin = mod.getSupabaseAdmin();
  }
  if (!admin) {
    throw new AppError(503, "auth_not_configured", "Authentication is not configured.");
  }

  const user = data.user;
  enterTelemetryContext({ userId: user.id, brandKey: null });
  return {
    user: { id: user.id, email: user.email ?? null },
    admin,
  };
}
