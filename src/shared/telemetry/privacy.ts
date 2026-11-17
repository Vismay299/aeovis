import type { SupabaseClient } from "@supabase/supabase-js";
import { POLICY_VERSION } from "./events.ts";

export type PrivacyChoice = {
  analytics: boolean;
  decidedAt: string;
  source: "onboarding" | "settings" | "banner";
  policyVersion: string;
};

export type PrivacySource = PrivacyChoice["source"];

type ConsentCacheEntry = { value: boolean | null; expiresAt: number };
const consentCache = new Map<string, ConsentCacheEntry>();
const CONSENT_TTL_MS = 60_000;

const telemetryIdCache = new Map<string, { value: string | null; expiresAt: number }>();
const TELEMETRY_ID_TTL_MS = 10 * 60_000;

export function clearConsentCache(userId?: string): void {
  if (userId) consentCache.delete(userId);
  else consentCache.clear();
}

export function clearTelemetryIdCache(brandKey?: string): void {
  if (brandKey) telemetryIdCache.delete(brandKey);
  else telemetryIdCache.clear();
}

export async function readPrivacyChoice(
  admin: SupabaseClient,
  userId: string,
): Promise<PrivacyChoice | null> {
  const { data, error } = await admin
    .from("user_privacy_choices")
    .select("analytics, decided_at, source, policy_version")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    analytics: Boolean(data.analytics),
    decidedAt: String(data.decided_at),
    source: data.source as PrivacySource,
    policyVersion: String(data.policy_version),
  };
}

export async function savePrivacyChoice(
  admin: SupabaseClient,
  userId: string,
  analytics: boolean,
  source: PrivacySource,
): Promise<PrivacyChoice> {
  const now = new Date().toISOString();
  const row = {
    user_id: userId,
    analytics,
    decided_at: now,
    source,
    policy_version: POLICY_VERSION,
    updated_at: now,
  };
  const { data, error } = await admin
    .from("user_privacy_choices")
    .upsert(row, { onConflict: "user_id" })
    .select("analytics, decided_at, source, policy_version")
    .single();
  clearConsentCache(userId);
  if (error) throw error;
  return {
    analytics: Boolean(data.analytics),
    decidedAt: String(data.decided_at),
    source: data.source as PrivacySource,
    policyVersion: String(data.policy_version),
  };
}

/** Cached consent lookup for captureServerEvent. Read error → false. */
export async function hasConsent(
  admin: SupabaseClient | null | undefined,
  userId: string | null | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!userId || !admin) return false;
  const cached = consentCache.get(userId);
  if (cached && cached.expiresAt > nowMs) return cached.value === true;
  try {
    const choice = await readPrivacyChoice(admin, userId);
    const value = choice ? choice.analytics : null;
    consentCache.set(userId, { value, expiresAt: nowMs + CONSENT_TTL_MS });
    return value === true;
  } catch {
    return false;
  }
}

export async function telemetryIdFor(
  admin: SupabaseClient | null | undefined,
  brandKey: string | null | undefined,
  nowMs = Date.now(),
): Promise<string | null> {
  if (!brandKey || !admin) return null;
  const cached = telemetryIdCache.get(brandKey);
  if (cached && cached.expiresAt > nowMs) return cached.value;
  try {
    const { data, error } = await admin
      .from("customer_brands")
      .select("telemetry_id")
      .eq("brand_key", brandKey)
      .maybeSingle();
    if (error) throw error;
    const value = data?.telemetry_id ? String(data.telemetry_id) : null;
    telemetryIdCache.set(brandKey, { value, expiresAt: nowMs + TELEMETRY_ID_TTL_MS });
    return value;
  } catch {
    return null;
  }
}
