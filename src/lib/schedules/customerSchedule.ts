// Portions ported from every-app/open-seo@c5f8db1 (MIT, Ac 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilitySchedule.ts:14-71
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeNextRunAt,
  skipReasonMessage,
  type ScheduleInterval,
  type ScheduleTime,
} from "../../shared/schedule.ts";
import { AppError } from "../http/errors.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import {
  requireApprovedPrice,
  recordApproval,
  type PricingContext,
} from "../pricing/pricedActions.ts";
import "../pricing/actions/index.ts";

export type CustomerScheduleView = {
  brandKey: string;
  status: "off" | "on" | "paused" | "operator";
  interval: ScheduleInterval | null;
  scheduleTime: ScheduleTime | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastCompletedAt: string | null;
  lastSkip: {
    reason: string;
    at: string;
    message: string;
  } | null;
  approvedMaxUsd: number | null;
  approvedAt: string | null;
  windows: Array<{
    windowAt: string;
    disposition: string;
    reason: string | null;
    message: string | null;
    jobId: string | null;
  }>;
};

export type SaveScheduleBody = {
  brand_key?: string;
  enabled: boolean;
  interval?: ScheduleInterval;
  scheduleTime?: ScheduleTime;
  maxUsd?: number;
};

export type ScanScheduleRow = {
  brand: string;
  display_name?: string | null;
  managed_by: string;
  enabled: boolean;
  cadence?: string | null;
  schedule_interval?: string | null;
  schedule_time?: ScheduleTime | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_skip_reason?: string | null;
  last_skip_at?: string | null;
  approved_max_usd?: number | null;
  approval_id?: string | null;
  customer_updated_by?: string | null;
  customer_updated_at?: string | null;
};

export function sameSlot(
  row: ScanScheduleRow | null | undefined,
  interval: ScheduleInterval,
  time: ScheduleTime | undefined,
): boolean {
  if (!row) return false;
  if (row.schedule_interval !== interval) return false;
  const existing = row.schedule_time;
  if (!time && !existing) return true;
  if (!time || !existing) return false;

  const sameHour = existing.hour === time.hour;
  const sameMinute = existing.minute === time.minute;
  const sameWeekday = interval !== "weekly" || existing.weekday === time.weekday;
  const sameTz = (existing.timeZone ?? null) === (time.timeZone ?? null);

  return sameHour && sameMinute && sameWeekday && sameTz;
}

export async function getCustomerSchedule(
  admin: SupabaseClient,
  ws: Workspace,
): Promise<CustomerScheduleView> {
  const brandKey = ws.brandKey;

  // 1. Fetch scan_schedules row
  const { data: scheduleRow, error: scheduleErr } = await admin
    .from("scan_schedules")
    .select("*")
    .eq("brand", brandKey)
    .maybeSingle();

  if (scheduleErr) {
    throw new AppError(500, "storage_unavailable", "Could not load schedule.", { cause: scheduleErr });
  }

  // 2. Fetch last 10 measurement_windows
  const { data: windowsData, error: windowsErr } = await admin
    .from("measurement_windows")
    .select("window_at, disposition, reason, job_id, finalized_at")
    .eq("brand", brandKey)
    .order("window_at", { ascending: false })
    .limit(10);

  if (windowsErr) {
    throw new AppError(500, "storage_unavailable", "Could not load schedule history.", { cause: windowsErr });
  }

  const windowsList = windowsData || [];

  // Determine status
  let status: "off" | "on" | "paused" | "operator" = "off";
  if (scheduleRow) {
    if (scheduleRow.managed_by === "operator") {
      status = scheduleRow.enabled ? "operator" : "off";
    } else {
      status = scheduleRow.enabled ? "on" : "paused";
    }
  }

  // Find last completed window (finalized)
  const lastFinalized = windowsList.find((w: any) => w.disposition === "finalized");
  const lastCompletedAt = lastFinalized
    ? new Date(lastFinalized.finalized_at || lastFinalized.window_at).toISOString()
    : null;

  // Last skip
  let lastSkip: CustomerScheduleView["lastSkip"] = null;
  if (scheduleRow?.last_skip_reason) {
    lastSkip = {
      reason: scheduleRow.last_skip_reason,
      at: scheduleRow.last_skip_at
        ? new Date(scheduleRow.last_skip_at).toISOString()
        : new Date().toISOString(),
      message: skipReasonMessage(scheduleRow.last_skip_reason),
    };
  }

  // Approval timestamp
  let approvedAt: string | null = null;
  if (scheduleRow?.approval_id) {
    try {
      const { data: appRow } = await admin
        .from("price_approvals")
        .select("created_at")
        .eq("id", scheduleRow.approval_id)
        .maybeSingle();
      if (appRow?.created_at) {
        approvedAt = new Date(appRow.created_at).toISOString();
      }
    } catch {
      // fallback to customer_updated_at if price_approvals table read fails
      if (scheduleRow.customer_updated_at) {
        approvedAt = new Date(scheduleRow.customer_updated_at).toISOString();
      }
    }
  } else if (scheduleRow?.customer_updated_at && scheduleRow?.approved_max_usd) {
    approvedAt = new Date(scheduleRow.customer_updated_at).toISOString();
  }

  const formattedWindows = windowsList.map((w: any) => ({
    windowAt: new Date(w.window_at).toISOString(),
    disposition: String(w.disposition),
    reason: w.reason ? String(w.reason) : null,
    message: w.reason ? skipReasonMessage(w.reason) : null,
    jobId: w.job_id ? String(w.job_id) : null,
  }));

  return {
    brandKey,
    status,
    interval: (scheduleRow?.schedule_interval as ScheduleInterval) || null,
    scheduleTime: scheduleRow?.schedule_time || null,
    nextRunAt: scheduleRow?.next_run_at ? new Date(scheduleRow.next_run_at).toISOString() : null,
    lastRunAt: scheduleRow?.last_run_at ? new Date(scheduleRow.last_run_at).toISOString() : null,
    lastCompletedAt,
    lastSkip,
    approvedMaxUsd: scheduleRow?.approved_max_usd != null ? Number(scheduleRow.approved_max_usd) : null,
    approvedAt,
    windows: formattedWindows,
  };
}

export type SaveCustomerScheduleDeps = {
  requireApprovedPrice?: typeof requireApprovedPrice;
  recordApproval?: typeof recordApproval;
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

export async function saveCustomerSchedule(
  admin: SupabaseClient,
  ws: Workspace,
  body: SaveScheduleBody,
  deps?: SaveCustomerScheduleDeps,
): Promise<CustomerScheduleView> {
  const brandKey = ws.brandKey;
  const now = deps?.now ? deps.now() : new Date();

  // 1. Check existing row
  const { data: existingRow } = await admin
    .from("scan_schedules")
    .select("*")
    .eq("brand", brandKey)
    .maybeSingle();

  if (existingRow?.managed_by === "operator" && existingRow?.enabled) {
    throw new AppError(
      409,
      "operator_schedule_active",
      "Perceev support manages this workspace's schedule. Contact support to change it.",
    );
  }

  if (body.enabled) {
    if (ws.role !== "owner") {
      throw new AppError(403, "owner_required", "Only owners can change recurring scan schedules.");
    }
    if (!body.interval) {
      throw new AppError(400, "invalid_request", "Choose how often to scan.");
    }
    if (body.maxUsd === undefined || body.maxUsd === null) {
      throw new AppError(400, "approval_required", "Review and approve the price before turning on scheduled scans.");
    }

    const pricingCtx: PricingContext = {
      brandKey,
      admin,
      env: deps?.env ?? process.env,
      now,
    };

    const approveFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
    const approval = await approveFn(
      "ai_visibility.schedule.save",
      pricingCtx,
      { panelKey: "default", scheduleInterval: body.interval },
      body.maxUsd,
    );

    const recordFn = deps?.recordApproval ?? recordApproval;
    const approvalId = await recordFn(admin, {
      brandKey,
      action: "ai_visibility.schedule.save",
      approvedMaxUsd: body.maxUsd,
      quote: approval.quote,
      source: "schedule",
      subject: { kind: "scan_schedule", id: brandKey },
      approvedBy: ws.user.id,
    });

    const isSlotKept =
      sameSlot(existingRow, body.interval, body.scheduleTime) &&
      existingRow.next_run_at &&
      new Date(existingRow.next_run_at).getTime() > now.getTime();

    const nextRunAt = isSlotKept
      ? existingRow.next_run_at
      : computeNextRunAt(body.interval, null, body.scheduleTime, { now: () => now.getTime() });

    const upsertPayload: Record<string, any> = {
      brand: brandKey,
      display_name: ws.brand?.display_name || existingRow?.display_name || brandKey,
      managed_by: "customer",
      enabled: true,
      cadence: body.interval,
      schedule_interval: body.interval,
      schedule_time: body.scheduleTime ?? null,
      next_run_at: nextRunAt,
      approved_max_usd: body.maxUsd,
      approval_id: approvalId,
      last_skip_reason: null,
      last_skip_at: null,
      customer_updated_by: ws.user.id,
      customer_updated_at: now.toISOString(),
      updated_at: now.toISOString(),
    };

    const { error: upsertErr } = await admin
      .from("scan_schedules")
      .upsert(upsertPayload, { onConflict: "brand" });

    if (upsertErr) {
      throw new AppError(503, "schedule_unavailable", "The schedule could not be saved. Please retry.", {
        cause: upsertErr,
      });
    }
  } else {
    // enabled: false (pause)
    if (!existingRow) {
      // If no row exists yet, nothing to pause
      return getCustomerSchedule(admin, ws);
    }

    const { error: updateErr } = await admin
      .from("scan_schedules")
      .update({
        enabled: false,
        customer_updated_by: ws.user.id,
        customer_updated_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("brand", brandKey);

    if (updateErr) {
      throw new AppError(503, "schedule_unavailable", "The schedule could not be paused. Please retry.", {
        cause: updateErr,
      });
    }
  }

  return getCustomerSchedule(admin, ws);
}
