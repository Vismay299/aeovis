import type { SupabaseClient, User } from "@supabase/supabase-js";
import { LoopsError, getContactNameParts, type LoopsContactPayload } from "../../shared/providers/loops/client.ts";
import { readEmailConfig, type EmailConfig } from "./config.ts";
import { TEMPLATE_CATEGORY, MILESTONES, MILESTONE_PROPERTY, type TransactionalTemplate, type EmailOutboxRow } from "./types.ts";
import { unsubscribeUrl } from "./links.ts";
import { readPreferences, type UserEmailPreferences } from "./preferences.ts";
import { trackEmailEvent } from "./telemetry.ts";

export type DeliverDeps = {
  admin: SupabaseClient;
  config?: EmailConfig;
  isFeatureEnabled?: (name: string, brandKey?: string) => Promise<boolean>;
  now?: Date;
  loopsClient?: {
    updateLoopsContact: (i: { apiKey: string; payload: LoopsContactPayload }) => Promise<void>;
    sendLoopsEvent: (i: {
      apiKey: string;
      payload: { email: string; userId: string; eventName: string; eventProperties?: Record<string, string | number | boolean> };
      idempotencyKey: string;
    }) => Promise<{ duplicate: boolean }>;
    sendLoopsTransactional: (i: {
      apiKey: string;
      transactionalId: string;
      email: string;
      dataVariables: Record<string, string>;
      idempotencyKey: string;
    }) => Promise<{ duplicate: boolean }>;
  };
};

export async function buildContactPayload(
  admin: SupabaseClient,
  row: EmailOutboxRow,
  user: User,
  prefs: UserEmailPreferences,
  cfg: EmailConfig,
): Promise<LoopsContactPayload> {
  const source = row.template === "contact_signup" ? "perceev-signup" : "perceev-app";

  // Name parts from metadata
  const fullName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name
      : typeof user.user_metadata?.name === "string"
        ? user.user_metadata.name
        : undefined;
  const nameParts = getContactNameParts(fullName);

  // Fetch active workspaces for user
  const { data: memberships } = await admin
    .from("customer_brand_memberships")
    .select("brand_key, customer_brands!inner(is_active)")
    .eq("user_id", user.id)
    .eq("customer_brands.is_active", true);

  const activeBrandKeys = (memberships ?? []).map((m: any) => m.brand_key as string);
  const workspaceCount = activeBrandKeys.length;

  // Fetch milestones for all active workspaces
  const milestoneMap = new Set<string>();
  if (activeBrandKeys.length > 0) {
    const { data: milestones } = await admin
      .from("workspace_milestones")
      .select("milestone")
      .in("brand_key", activeBrandKeys);

    if (milestones) {
      for (const m of milestones) {
        milestoneMap.add(m.milestone);
      }
    }
  }

  const milestoneProperties: Record<string, boolean> = {};
  for (const m of MILESTONES) {
    const propName = MILESTONE_PROPERTY[m];
    milestoneProperties[propName] = milestoneMap.has(m);
  }

  const payload: LoopsContactPayload = {
    email: user.email!,
    userId: user.id,
    userGroup: "app-user",
    source,
    workspaceCount,
    ...nameParts,
    ...milestoneProperties,
  };

  if (row.template === "contact_signup" && prefs.product_updates && cfg.productUpdatesListId) {
    payload.mailingLists = {
      [cfg.productUpdatesListId]: true,
    };
  }

  return payload;
}

export async function deliverOutboxRow(
  row: EmailOutboxRow,
  deps: DeliverDeps,
): Promise<"sent" | "skipped" | "retry" | "failed"> {
  const admin = deps.admin;
  const config = deps.config ?? readEmailConfig();
  const now = deps.now ?? new Date();

  // Helper to mark row skipped
  const markSkipped = async (reason: string) => {
    await admin
      .from("email_outbox")
      .update({
        status: "skipped",
        skip_reason: reason,
        claimed_until: null,
        claimed_by: null,
      })
      .eq("id", row.id);
    trackEmailEvent("email:skipped", { template: row.template, reason });
    return "skipped" as const;
  };

  // a. Flag check
  let isEnabled = true;
  if (deps.isFeatureEnabled) {
    isEnabled = await deps.isFeatureEnabled("lifecycle_email", row.brand_key ?? undefined);
  } else {
    const { isFeatureEnabled } = await import("../features/flags.ts");
    isEnabled = await isFeatureEnabled("lifecycle_email", row.brand_key ?? undefined);
  }
  if (!isEnabled) {
    return markSkipped("flag_off");
  }

  // API key check
  if (!config.apiKey) {
    return markSkipped("loops_not_configured");
  }

  // Transactional template id check
  if (row.kind === "transactional") {
    const templateId = config.templateIds[row.template as TransactionalTemplate];
    if (!templateId) {
      return markSkipped("template_not_configured");
    }
  }

  // b. User check
  let user: User | null = null;
  try {
    const { data, error } = await admin.auth.admin.getUserById(row.user_id);
    if (error || !data?.user || !data.user.email_confirmed_at) {
      return markSkipped("recipient_unavailable");
    }
    user = data.user;
  } catch {
    return markSkipped("recipient_unavailable");
  }

  if (!user || !user.email) {
    return markSkipped("recipient_unavailable");
  }

  // c. Brand-bound rows check
  if (row.brand_key) {
    const { data: brand } = await admin
      .from("customer_brands")
      .select("is_active")
      .eq("brand_key", row.brand_key)
      .maybeSingle();

    if (!brand || !brand.is_active) {
      return markSkipped("not_member");
    }

    const { data: member } = await admin
      .from("customer_brand_memberships")
      .select("role")
      .eq("brand_key", row.brand_key)
      .eq("user_id", row.user_id)
      .maybeSingle();

    if (!member) {
      return markSkipped("not_member");
    }
  }

  // Category preference check
  const prefs = await readPreferences(admin, row.user_id);
  if (row.kind === "transactional") {
    const category = TEMPLATE_CATEGORY[row.template as TransactionalTemplate];
    let prefAllowed = true;
    if (category === "scan_results") prefAllowed = prefs.scan_results;
    else if (category === "schedule_alerts") prefAllowed = prefs.schedule_alerts;
    else if (category === "spend_alerts") prefAllowed = prefs.spend_alerts;

    if (!prefAllowed) {
      return markSkipped("preference_off");
    }
  }

  // d. Deliver via Loops
  const loops = deps.loopsClient ?? (await import("../../shared/providers/loops/client.ts"));
  try {
    let duplicate = false;

    if (row.kind === "transactional") {
      const templateId = config.templateIds[row.template as TransactionalTemplate]!;
      const category = TEMPLATE_CATEGORY[row.template as TransactionalTemplate];
      const unsub = unsubscribeUrl(config, user.id, category);
      const dataVariables: Record<string, string> = {
        ...row.data,
        unsubscribeUrl: unsub,
      };

      const res = await loops.sendLoopsTransactional({
        apiKey: config.apiKey,
        transactionalId: templateId,
        email: user.email,
        dataVariables,
        idempotencyKey: row.id,
      });
      duplicate = res.duplicate;
    } else if (row.kind === "event") {
      const res = await loops.sendLoopsEvent({
        apiKey: config.apiKey,
        payload: {
          email: user.email,
          userId: user.id,
          eventName: row.template === "signed_up" ? "signed_up" : row.template,
        },
        idempotencyKey: row.id,
      });
      duplicate = res.duplicate;
    } else if (row.kind === "contact") {
      const payload = await buildContactPayload(admin, row, user, prefs, config);
      await loops.updateLoopsContact({
        apiKey: config.apiKey,
        payload,
      });
    }

    // e. Mark sent
    await admin
      .from("email_outbox")
      .update({
        status: "sent",
        sent_at: now.toISOString(),
        loops_duplicate: duplicate,
        claimed_until: null,
        claimed_by: null,
      })
      .eq("id", row.id);

    trackEmailEvent("email:sent", {
      template: row.template,
      kind: row.kind,
      duplicate,
    });

    return "sent";
  } catch (err: unknown) {
    if (err instanceof LoopsError) {
      if (
        err.code === "rate_limited" ||
        err.code === "server" ||
        err.code === "timeout" ||
        err.code === "network"
      ) {
        if (row.attempts < 5) {
          // Retry with exponential backoff: 2^attempts minutes
          const backoffMinutes = Math.pow(2, row.attempts);
          const nextAttempt = new Date(now.getTime() + backoffMinutes * 60_000);

          await admin
            .from("email_outbox")
            .update({
              status: "pending",
              next_attempt_at: nextAttempt.toISOString(),
              error_code: err.code,
              claimed_until: null,
              claimed_by: null,
            })
            .eq("id", row.id);

          trackEmailEvent("email:failed", { template: row.template, error_code: err.code });
          return "retry";
        } else {
          // Exhausted
          await admin
            .from("email_outbox")
            .update({
              status: "failed",
              error_code: err.code,
              claimed_until: null,
              claimed_by: null,
            })
            .eq("id", row.id);

          trackEmailEvent("email:failed", { template: row.template, error_code: err.code });
          return "failed";
        }
      }

      // Rejected
      const rejectCode = `rejected_${err.status}`;
      await admin
        .from("email_outbox")
        .update({
          status: "failed",
          error_code: rejectCode,
          claimed_until: null,
          claimed_by: null,
        })
        .eq("id", row.id);

      trackEmailEvent("email:failed", { template: row.template, error_code: rejectCode });
      return "failed";
    }

    // Internal error
    console.error("[email] deliver failed", { outboxId: row.id, template: row.template });
    await admin
      .from("email_outbox")
      .update({
        status: "failed",
        error_code: "internal_error",
        claimed_until: null,
        claimed_by: null,
      })
      .eq("id", row.id);

    trackEmailEvent("email:failed", { template: row.template, error_code: "internal_error" });
    return "failed";
  }
}
