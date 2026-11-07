import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/errors.ts";
import { readEmailConfig, type EmailConfig } from "./config.ts";
import { updateLoopsContact, type LoopsDeps } from "../providers/loops/client.ts";

export type UserEmailPreferences = {
  user_id: string;
  product_updates: boolean;
  product_updates_changed_at: string | null;
  product_updates_source: "onboarding" | "settings" | "unsubscribe_link" | "signup_default" | null;
  scan_results: boolean;
  schedule_alerts: boolean;
  spend_alerts: boolean;
  created_at?: string;
  updated_at?: string;
};

export const DEFAULT_PREFERENCES: Omit<UserEmailPreferences, "user_id"> = {
  product_updates: false,
  product_updates_changed_at: null,
  product_updates_source: null,
  scan_results: true,
  schedule_alerts: true,
  spend_alerts: true,
};

export async function readPreferences(
  admin: SupabaseClient,
  userId: string,
): Promise<UserEmailPreferences> {
  const { data, error } = await admin
    .from("user_email_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return {
      user_id: userId,
      ...DEFAULT_PREFERENCES,
    };
  }

  return data as UserEmailPreferences;
}

export async function readPreferencesMany(
  admin: SupabaseClient,
  userIds: string[],
): Promise<Map<string, UserEmailPreferences>> {
  const result = new Map<string, UserEmailPreferences>();
  if (userIds.length === 0) {
    return result;
  }

  const { data, error } = await admin
    .from("user_email_preferences")
    .select("*")
    .in("user_id", userIds);

  if (error) {
    throw error;
  }

  const found = new Set<string>();
  if (Array.isArray(data)) {
    for (const row of data) {
      result.set(row.user_id, row as UserEmailPreferences);
      found.add(row.user_id);
    }
  }

  for (const uid of userIds) {
    if (!found.has(uid)) {
      result.set(uid, {
        user_id: uid,
        ...DEFAULT_PREFERENCES,
      });
    }
  }

  return result;
}

export async function savePreferences(
  admin: SupabaseClient,
  userId: string,
  patch: {
    product_updates?: boolean;
    scan_results?: boolean;
    schedule_alerts?: boolean;
    spend_alerts?: boolean;
  },
  source?: "onboarding" | "settings" | "unsubscribe_link" | "signup_default",
): Promise<UserEmailPreferences> {
  const current = await readPreferences(admin, userId);
  const nextProductUpdates =
    patch.product_updates !== undefined ? patch.product_updates : current.product_updates;
  const productUpdatesChanged = patch.product_updates !== undefined && patch.product_updates !== current.product_updates;

  const toUpsert = {
    user_id: userId,
    product_updates: nextProductUpdates,
    product_updates_changed_at: productUpdatesChanged ? new Date().toISOString() : current.product_updates_changed_at,
    product_updates_source: productUpdatesChanged ? (source ?? "settings") : current.product_updates_source,
    scan_results: patch.scan_results !== undefined ? patch.scan_results : current.scan_results,
    schedule_alerts: patch.schedule_alerts !== undefined ? patch.schedule_alerts : current.schedule_alerts,
    spend_alerts: patch.spend_alerts !== undefined ? patch.spend_alerts : current.spend_alerts,
  };

  const { data, error } = await admin
    .from("user_email_preferences")
    .upsert(toUpsert)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as UserEmailPreferences;
}

export async function setProductUpdates(
  admin: SupabaseClient,
  user: { id: string; email: string },
  optIn: boolean,
  source: "onboarding" | "settings" | "unsubscribe_link" | "signup_default",
  deps?: {
    config?: EmailConfig;
    loops?: LoopsDeps;
  },
): Promise<{ loopsSynced: boolean; preferences: UserEmailPreferences }> {
  const config = deps?.config ?? readEmailConfig();

  let loopsSynced = false;
  if (config.apiKey && config.productUpdatesListId) {
    try {
      const payload: {
        email: string;
        userId: string;
        mailingLists: Record<string, boolean>;
        subscribed?: boolean;
      } = {
        email: user.email,
        userId: user.id,
        mailingLists: {
          [config.productUpdatesListId]: optIn,
        },
      };
      if (optIn) {
        payload.subscribed = true;
      }
      await updateLoopsContact(
        {
          apiKey: config.apiKey,
          payload,
        },
        deps?.loops,
      );
      loopsSynced = true;
    } catch (_err) {
      throw new AppError(
        502,
        "email_provider_unavailable",
        "We couldn't save your email choice. Please try again.",
      );
    }
  }

  const preferences = await savePreferences(
    admin,
    user.id,
    { product_updates: optIn },
    source,
  );

  return { loopsSynced, preferences };
}
