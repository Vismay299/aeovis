// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/email/onboarding-drip.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled } from "../features/flags.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { readEmailConfig } from "./config.ts";
import { enqueueEmail } from "./outbox.ts";
import { workspaceRecipients } from "./recipients.ts";
import { buildSpendCapData } from "./templates.ts";

export type SpendCapNotifyInput = {
  brandKey: string;
  reason: "daily_cap" | "workspace_cap";
  limitUsd?: number | null;
  now?: Date | string | null;
};

export type SpendCapNotifyDeps = {
  admin?: SupabaseClient;
  appUrl?: string;
  isFeatureEnabled?: typeof isFeatureEnabled;
  config?: ReturnType<typeof readEmailConfig>;
};

export async function notifySpendCapRefused(
  i: SpendCapNotifyInput,
  deps?: SpendCapNotifyDeps,
): Promise<void> {
  try {
    const isEnabled = deps?.isFeatureEnabled
      ? await deps.isFeatureEnabled("lifecycle_email", i.brandKey)
      : await isFeatureEnabled("lifecycle_email", i.brandKey);

    if (!isEnabled) {
      return;
    }

    const admin = deps?.admin ?? getSupabaseAdmin();
    if (!admin) {
      return;
    }

    const { data: brand, error: brandError } = await admin
      .from("customer_brands")
      .select("brand_key, display_name, name, is_active")
      .eq("brand_key", i.brandKey)
      .maybeSingle();

    if (brandError || !brand || !brand.is_active) {
      return;
    }

    const owners = await workspaceRecipients(admin, i.brandKey, {
      role: "owner",
      category: "spend_alerts",
    });

    if (owners.length === 0) {
      return;
    }

    const baseDate = i.now ? new Date(i.now) : new Date();
    const period =
      i.reason === "daily_cap"
        ? baseDate.toISOString().slice(0, 10)
        : baseDate.toISOString().slice(0, 7);

    const config = deps?.config ?? readEmailConfig();
    const appUrl = deps?.appUrl ?? config.appUrl;
    const data = buildSpendCapData(
      {
        reason: i.reason,
        limitUsd: i.limitUsd,
        now: baseDate,
      },
      brand,
      { appUrl },
    );

    for (const owner of owners) {
      const dedupeKey = `spend_cap_reached:${i.brandKey}:${i.reason}:${period}:${owner.userId}`;
      await enqueueEmail(admin, {
        kind: "transactional",
        template: "spend_cap_reached",
        userId: owner.userId,
        brandKey: i.brandKey,
        dedupeKey,
        data,
      });
    }
  } catch (error) {
    // Non-blocking notifier: never throw
    console.warn("[email] spend cap notification failed", {
      brandKey: i.brandKey,
      error,
    });
  }
}
