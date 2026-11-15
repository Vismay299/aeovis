import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SETUP_STEPS,
  type SetupStep,
  type SetupActivation,
  getSetupStepStatus,
  visibleSetupSteps,
} from "../../shared/setup-steps.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";

export type SetupActivationResult = SetupActivation & {
  visible: SetupStep[];
  steps: Array<{ id: SetupStep; status: "done" | "skipped" | "todo" }>;
};

async function safeQuery(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn();
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    const msg = (err as { message?: string })?.message ?? "";
    if (code === "42P01" || msg.includes("does not exist")) {
      return false;
    }
    // Any table missing or query error on optional checks maps to not done
    return false;
  }
}

export async function getSetupActivation(
  admin: SupabaseClient,
  ws: Workspace,
  features: Record<string, boolean>,
): Promise<SetupActivationResult> {
  const brandKey = ws.brandKey;
  const userId = ws.user.id;
  const role = ws.role;

  const [
    hasApprovedPanel,
    hasScans,
    hasGsc,
    hasAudit,
    hasSchedule,
    hasGa4,
    hasDraft,
    hasTeam,
    dismissedSteps,
  ] = await Promise.all([
    // 1. questions: workspace has an approved panel
    safeQuery(async () => {
      const { data } = await admin
        .from("repair_artifacts")
        .select("id")
        .eq("brand", brandKey)
        .eq("kind", "panel")
        .eq("artifact_key", "default")
        .eq("state", "approved")
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    }),

    // 2. scan: any scans row for the workspace
    safeQuery(async () => {
      const { data } = await admin
        .from("scans")
        .select("id")
        .eq("brand_key", brandKey)
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    }),

    // 3. gsc: enabled OAuth gsc_connections row
    safeQuery(async () => {
      const { data } = await admin
        .from("gsc_connections")
        .select("enabled")
        .eq("brand_key", brandKey)
        .limit(1)
        .maybeSingle();
      return Boolean(data?.enabled);
    }),

    // 4. audit: any site_audits row
    safeQuery(async () => {
      const { data } = await admin
        .from("site_audits")
        .select("id")
        .eq("brand_key", brandKey)
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    }),

    // 5. schedule: customer-managed and enabled scan_schedules
    safeQuery(async () => {
      const { data } = await admin
        .from("scan_schedules")
        .select("enabled, managed_by")
        .or(`brand_key.eq.${brandKey},brand.eq.${brandKey}`)
        .eq("managed_by", "customer")
        .eq("enabled", true)
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    }),

    // 6. ga4: ga4_connections row
    safeQuery(async () => {
      const { data } = await admin
        .from("ga4_connections")
        .select("brand_key")
        .eq("brand_key", brandKey)
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    }),

    // 7. draft: any content_items row
    safeQuery(async () => {
      const { data } = await admin
        .from("content_items")
        .select("id")
        .eq("brand_key", brandKey)
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    }),

    // 8. team: more than one membership or pending invite
    safeQuery(async () => {
      const { count: memberCount } = await admin
        .from("customer_brand_memberships")
        .select("user_id", { count: "exact", head: true })
        .eq("brand_key", brandKey);

      if ((memberCount ?? 0) > 1) return true;

      const { count: inviteCount } = await admin
        .from("customer_team_invites")
        .select("id", { count: "exact", head: true })
        .eq("brand_key", brandKey)
        .eq("status", "pending");

      return (inviteCount ?? 0) > 0;
    }),

    // Dismissals for this user and workspace
    (async () => {
      try {
        const { data } = await admin
          .from("workspace_setup_dismissals")
          .select("step")
          .eq("user_id", userId)
          .eq("brand_key", brandKey);
        return ((data ?? []) as Array<{ step: string }>).map((r) => r.step as SetupStep);
      } catch {
        return [] as SetupStep[];
      }
    })(),
  ]);

  const completed: Record<SetupStep, boolean> = {
    questions: hasApprovedPanel,
    scan: hasScans,
    gsc: hasGsc,
    audit: hasAudit,
    schedule: hasSchedule,
    ga4: hasGa4,
    draft: hasDraft,
    team: hasTeam,
  };

  const activation: SetupActivation = {
    completed,
    dismissed: dismissedSteps,
  };

  const visible = visibleSetupSteps(features, role);
  const steps = visible.map((id) => ({
    id,
    status: getSetupStepStatus(activation, id),
  }));

  return {
    ...activation,
    visible,
    steps,
  };
}

export async function setDismissed(
  admin: SupabaseClient,
  userId: string,
  brandKey: string,
  step: SetupStep,
  dismissed: boolean,
): Promise<void> {
  if (dismissed) {
    await admin.from("workspace_setup_dismissals").upsert(
      {
        user_id: userId,
        brand_key: brandKey,
        step,
        dismissed_at: new Date().toISOString(),
      },
      { onConflict: "user_id,brand_key,step" },
    );
  } else {
    await admin
      .from("workspace_setup_dismissals")
      .delete()
      .eq("user_id", userId)
      .eq("brand_key", brandKey)
      .eq("step", step);
  }
}
