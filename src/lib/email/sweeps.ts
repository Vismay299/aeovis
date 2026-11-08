// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/services/firstAuditEmails.ts, src/server/email/onboarding-drip.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { readEmailConfig } from "./config.ts";
import { enqueueEmail } from "./outbox.ts";
import { workspaceRecipients } from "./recipients.ts";
import {
  buildScanFinishedData,
  buildScheduleSkippedData,
  buildSpendCapData,
} from "./templates.ts";

export const LOOKBACK_MS = 30 * 60_000;
export const NO_EMAIL_REASONS = [
  "active_scan_overlap",
  "bounded_catchup_elapsed",
] as const;

export type SweepsDeps = {
  appUrl?: string;
  config?: ReturnType<typeof readEmailConfig>;
};

export async function sweepScans(
  admin: SupabaseClient,
  now = new Date(),
  deps?: SweepsDeps,
): Promise<{ scans: number; enqueued: number }> {
  const config = deps?.config ?? readEmailConfig();
  const appUrl = deps?.appUrl ?? config.appUrl;
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();

  const { data: scans, error: scansError } = await admin
    .from("scans")
    .select("id, brand_key, created_at, prompts_tracked, prompts_mentioned, raw_results")
    .not("brand_key", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);

  if (scansError) {
    throw scansError;
  }
  if (!scans || scans.length === 0) {
    return { scans: 0, enqueued: 0 };
  }

  const brandKeys = [...new Set(scans.map((s) => s.brand_key).filter(Boolean))];
  const { data: brands, error: brandsError } = await admin
    .from("customer_brands")
    .select("brand_key, display_name, name, is_active")
    .in("brand_key", brandKeys);

  if (brandsError) {
    throw brandsError;
  }

  const brandMap = new Map((brands ?? []).map((b) => [b.brand_key, b]));
  let enqueued = 0;

  for (const scan of scans) {
    if (!scan.brand_key) continue;
    const brand = brandMap.get(scan.brand_key);
    if (!brand || !brand.is_active) continue;

    const recipients = await workspaceRecipients(admin, scan.brand_key, {
      role: "any",
      category: "scan_results",
    });

    if (recipients.length === 0) continue;

    const data = buildScanFinishedData(scan, brand, { appUrl });

    for (const recipient of recipients) {
      const dedupeKey = `scan_finished:${scan.id}:${recipient.userId}`;
      const res = await enqueueEmail(admin, {
        kind: "transactional",
        template: "scan_finished",
        userId: recipient.userId,
        brandKey: scan.brand_key,
        dedupeKey,
        data,
      });
      if (res.created) {
        enqueued++;
      }
    }
  }

  return { scans: scans.length, enqueued };
}

export async function sweepWindows(
  admin: SupabaseClient,
  now = new Date(),
  deps?: SweepsDeps,
): Promise<{ windows: number; enqueued: number }> {
  const config = deps?.config ?? readEmailConfig();
  const appUrl = deps?.appUrl ?? config.appUrl;
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();

  // 1. Check scan_schedules table & managed_by column
  let schedulesData: Array<{ brand: string; managed_by?: string; next_run_at?: string | null }> | null = null;
  try {
    const { data, error } = await admin
      .from("scan_schedules")
      .select("brand, managed_by, next_run_at");
    if (error) {
      // Column or table doesn't exist
      return { windows: 0, enqueued: 0 };
    }
    schedulesData = data;
  } catch {
    return { windows: 0, enqueued: 0 };
  }

  if (!schedulesData) {
    return { windows: 0, enqueued: 0 };
  }

  const customerSchedules = new Map<string, { brand: string; next_run_at?: string | null }>();
  for (const s of schedulesData) {
    if (s.managed_by === "customer") {
      customerSchedules.set(s.brand, s);
    }
  }

  if (customerSchedules.size === 0) {
    return { windows: 0, enqueued: 0 };
  }

  // 2. Query blocked measurement_windows
  let windows: Array<{
    brand: string;
    window_at: string;
    disposition: string;
    reason: string | null;
    recorded_at?: string | null;
  }> | null = null;

  try {
    const { data, error } = await admin
      .from("measurement_windows")
      .select("brand, window_at, disposition, reason, recorded_at")
      .eq("disposition", "blocked")
      .gte("recorded_at", since)
      .limit(200);

    if (error) {
      return { windows: 0, enqueued: 0 };
    }
    windows = data;
  } catch {
    return { windows: 0, enqueued: 0 };
  }

  if (!windows || windows.length === 0) {
    return { windows: 0, enqueued: 0 };
  }

  const filteredWindows = windows.filter((w) => customerSchedules.has(w.brand));
  if (filteredWindows.length === 0) {
    return { windows: 0, enqueued: 0 };
  }

  const brandKeys = [...new Set(filteredWindows.map((w) => w.brand))];
  const { data: brands, error: brandsError } = await admin
    .from("customer_brands")
    .select("brand_key, display_name, name, is_active")
    .in("brand_key", brandKeys);

  if (brandsError) {
    throw brandsError;
  }

  const brandMap = new Map((brands ?? []).map((b) => [b.brand_key, b]));
  let enqueued = 0;

  for (const window of filteredWindows) {
    const reason = window.reason || "start_failed";
    if (NO_EMAIL_REASONS.includes(reason as (typeof NO_EMAIL_REASONS)[number])) {
      continue;
    }

    const brand = brandMap.get(window.brand);
    if (!brand || !brand.is_active) continue;

    const windowDate = window.recorded_at ? new Date(window.recorded_at) : now;
    const utcDay = windowDate.toISOString().slice(0, 10);
    const utcMonth = windowDate.toISOString().slice(0, 7);

    if (reason === "daily_cap" || reason === "workspace_cap") {
      const period = reason === "daily_cap" ? utcDay : utcMonth;
      const owners = await workspaceRecipients(admin, window.brand, {
        role: "owner",
        category: "spend_alerts",
      });

      if (owners.length === 0) continue;

      const data = buildSpendCapData(
        {
          reason,
          limitUsd: null,
          now: windowDate,
        },
        brand,
        { appUrl },
      );

      for (const owner of owners) {
        const dedupeKey = `spend_cap_reached:${window.brand}:${reason}:${period}:${owner.userId}`;
        const res = await enqueueEmail(admin, {
          kind: "transactional",
          template: "spend_cap_reached",
          userId: owner.userId,
          brandKey: window.brand,
          dedupeKey,
          data,
        });
        if (res.created) {
          enqueued++;
        }
      }
    } else {
      const owners = await workspaceRecipients(admin, window.brand, {
        role: "owner",
        category: "schedule_alerts",
      });

      if (owners.length === 0) continue;

      const schedule = customerSchedules.get(window.brand);
      const data = buildScheduleSkippedData(
        window,
        brand,
        schedule?.next_run_at,
        { appUrl },
      );

      for (const owner of owners) {
        const dedupeKey = `schedule_skipped:${window.brand}:${reason}:${utcDay}:${owner.userId}`;
        const res = await enqueueEmail(admin, {
          kind: "transactional",
          template: "schedule_skipped",
          userId: owner.userId,
          brandKey: window.brand,
          dedupeKey,
          data,
        });
        if (res.created) {
          enqueued++;
        }
      }
    }
  }

  return { windows: filteredWindows.length, enqueued };
}

export async function sweepMilestones(
  admin: SupabaseClient,
  now = new Date(),
  _deps?: SweepsDeps,
): Promise<{ candidates: number; milestones: number; contacts: number }> {
  const { data: candidates, error: candError } = await admin.rpc(
    "email_milestone_candidates",
    { p_limit: 500 },
  );

  if (candError) {
    throw candError;
  }

  if (!candidates || candidates.length === 0) {
    return { candidates: 0, milestones: 0, contacts: 0 };
  }

  let milestonesInserted = 0;
  const brandMilestones = new Map<string, Array<{ milestone: string; reached_at: string }>>();

  for (const c of candidates as Array<{ brand_key: string; milestone: string; reached_at: string }>) {
    const { error: insError } = await admin
      .from("workspace_milestones")
      .insert({
        brand_key: c.brand_key,
        milestone: c.milestone,
        reached_at: c.reached_at,
      });

    if (!insError) {
      milestonesInserted++;
      const list = brandMilestones.get(c.brand_key) ?? [];
      list.push(c);
      brandMilestones.set(c.brand_key, list);
    }
  }

  if (brandMilestones.size === 0) {
    return { candidates: candidates.length, milestones: milestonesInserted, contacts: 0 };
  }

  // Find workspace members of active brands that achieved milestones
  const activeBrands = [...brandMilestones.keys()];
  const { data: brandRows } = await admin
    .from("customer_brands")
    .select("brand_key, is_active")
    .in("brand_key", activeBrands);

  const activeSet = new Set(
    (brandRows ?? []).filter((b) => b.is_active).map((b) => b.brand_key),
  );

  const slot = now.toISOString().slice(0, 16);
  const enqueuedUsers = new Set<string>();
  let contactsEnqueued = 0;

  for (const brandKey of activeBrands) {
    if (!activeSet.has(brandKey)) continue;

    const { data: members, error: memError } = await admin
      .from("customer_brand_memberships")
      .select("user_id")
      .eq("brand_key", brandKey);

    if (memError || !members) continue;

    for (const member of members) {
      if (enqueuedUsers.has(member.user_id)) continue;
      enqueuedUsers.add(member.user_id);

      const dedupeKey = `contact_milestones:${member.user_id}:${slot}`;
      const res = await enqueueEmail(admin, {
        kind: "contact",
        template: "contact_milestones",
        userId: member.user_id,
        brandKey,
        dedupeKey,
        data: { reason: "milestone" },
      });
      if (res.created) {
        contactsEnqueued++;
      }
    }
  }

  return {
    candidates: candidates.length,
    milestones: milestonesInserted,
    contacts: contactsEnqueued,
  };
}
