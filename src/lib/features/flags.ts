import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { resolveNodeEnv } from "../operatorPerimeter.js";
import { FEATURES } from "./names.ts";
import type { FeatureName } from "./names.ts";

export type FeatureFlagDeps = {
  env?: Record<string, string | undefined>;
  admin?: SupabaseClient | null;
  now?: () => number;
};

const CACHE_MS = 30_000;
const cache = new Map<string, { value: boolean; expiresAt: number }>();

export function featureEnvName(name: FeatureName): string {
  return `FEATURE_${name.toUpperCase()}`;
}

function envAllows(name: FeatureName, brandKey: string | undefined, env: Record<string, string | undefined>): boolean {
  const envName = featureEnvName(name);
  const mode = String(env[envName] ?? "").trim().toLowerCase();
  if (mode === "on") return true;
  if (mode === "off") return false;
  if (mode === "allowlist") {
    if (!brandKey) return false;
    const brands = String(env[`${envName}_BRANDS`] ?? "")
      .split(",")
      .map((brand) => brand.trim())
      .filter(Boolean);
    return brands.includes(brandKey);
  }
  return resolveNodeEnv({ NODE_ENV: env.NODE_ENV, VERCEL_ENV: env.VERCEL_ENV }) !== "production";
}

async function spendControlsAllow(
  spendFeatures: readonly string[],
  brandKey: string | undefined,
  deps: FeatureFlagDeps | undefined
): Promise<boolean> {
  if (spendFeatures.length === 0) return true;
  const admin = deps && "admin" in deps ? deps.admin : getSupabaseAdmin();
  if (!admin) return false;
  try {
    const { data, error } = await admin
      .from("paid_feature_controls")
      .select("feature, enabled, mode, brand_allowlist")
      .in("feature", spendFeatures as string[]);
    if (error) return false;
    const rows = (data ?? []) as Array<{
      feature: string;
      enabled: boolean;
      mode: string;
      brand_allowlist: string[] | null;
    }>;
    return spendFeatures.every((feature) => {
      const row = rows.find((candidate) => candidate.feature === feature);
      if (!row || row.enabled !== true) return false;
      if (row.mode === "all") return true;
      return brandKey !== undefined && (row.brand_allowlist ?? []).includes(brandKey);
    });
  } catch {
    return false;
  }
}

export async function isFeatureEnabled(
  name: FeatureName,
  brandKey?: string,
  deps?: FeatureFlagDeps
): Promise<boolean> {
  const now = deps?.now ?? Date.now;
  const cacheKey = `${name}|${brandKey ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now()) return cached.value;

  const env = deps?.env ?? process.env;
  let value = false;
  if (envAllows(name, brandKey, env)) {
    value = await spendControlsAllow(FEATURES[name].spend, brandKey, deps);
  }
  cache.set(cacheKey, { value, expiresAt: now() + CACHE_MS });
  return value;
}
