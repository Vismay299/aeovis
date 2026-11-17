import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import { normalizeCustomerBrand } from "../customerProvisioning.js";
import { requireWorkspace as defaultRequireWorkspace, type Workspace } from "../workspace/requireWorkspace.ts";
import { saveQuestionSettings as defaultSaveQuestionSettings } from "../questions/workspaceQuestions.ts";
import { startSiteAudit as defaultStartSiteAudit } from "../audit/service.ts";
import { importFreeScanQuestions as defaultImportFreeScanQuestions } from "./freeScanHandoff.ts";
import { getOnboardingState as defaultGetOnboardingState, type OnboardingState } from "./state.ts";
import { trackOnboardingServerEvent } from "./telemetry.ts";
import { websiteStepBodySchema } from "./onboarding.contract.ts";

export type SaveWebsiteDeps = {
  admin?: SupabaseClient;
  requireWorkspace?: typeof defaultRequireWorkspace;
  saveQuestionSettings?: typeof defaultSaveQuestionSettings;
  startSiteAudit?: typeof defaultStartSiteAudit;
  importFreeScanQuestions?: typeof defaultImportFreeScanQuestions;
  getOnboardingState?: typeof defaultGetOnboardingState;
  createCustomerWorkspaceRpc?: (admin: SupabaseClient, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
};

export async function saveOnboardingWebsite(
  request: Request,
  user: { id: string; email?: string | null; email_confirmed_at?: string | null; confirmed_at?: string | null },
  rawBody: unknown,
  admin: SupabaseClient,
  deps?: SaveWebsiteDeps,
): Promise<OnboardingState> {
  // 1. Email confirmation check
  let isConfirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
  if (user.email_confirmed_at === undefined && user.confirmed_at === undefined) {
    try {
      const { data: userData } = await admin.auth.admin.getUserById(user.id);
      isConfirmed = Boolean(userData?.user?.email_confirmed_at || (userData?.user as any)?.confirmed_at);
    } catch {
      isConfirmed = true;
    }
  }

  if (!isConfirmed) {
    throw new AppError(403, "email_unverified", "Verify your email before setting up a workspace.");
  }

  // Parse and validate body
  const body = websiteStepBodySchema.parse(rawBody);

  // 2. Normalize website & brand name
  let rawWebsite = body.website;
  if (!/^https?:\/\//i.test(rawWebsite)) {
    rawWebsite = `https://${rawWebsite}`;
  }

  const normalized = normalizeCustomerBrand({
    brandKey: undefined,
    brandName: body.brandName,
    website: rawWebsite,
  });

  if (normalized.error || !normalized.value) {
    if (normalized.error && normalized.error.includes("brand_name")) {
      throw new AppError(400, "brand_name_invalid", "Enter your company or brand name.");
    }
    throw new AppError(400, "website_invalid", "Enter a valid website, like acme.com.");
  }
  const val = normalized.value;

  // 3. Workspace check
  const { data: existingRow } = await admin
    .from("user_onboarding")
    .select("user_id, brand_key, steps, handoff")
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: memberships } = await admin
    .from("customer_brand_memberships")
    .select("brand_key, role")
    .eq("user_id", user.id);

  const userMemberships = memberships ?? [];

  let brandKey: string | null = null;

  if (existingRow?.brand_key && userMemberships.some((m) => m.brand_key === existingRow.brand_key)) {
    // User already owns this onboarding workspace
    brandKey = existingRow.brand_key;

    // Check if it has scans
    const { count: scansCount } = await admin
      .from("scans")
      .select("id", { count: "exact", head: true })
      .eq("brand_key", brandKey);

    const hasScans = (scansCount ?? 0) > 0;
    if (hasScans) {
      // Check if website or name changes
      const { data: currentBrand } = await admin
        .from("customer_brands")
        .select("display_name, website, website_host")
        .eq("brand_key", brandKey)
        .maybeSingle();

      const websiteChanged =
        currentBrand &&
        (currentBrand.website !== val.website ||
          currentBrand.website_host !== val.website_host ||
          currentBrand.display_name !== val.display_name);

      if (websiteChanged) {
        throw new AppError(
          409,
          "website_locked",
          "This workspace already has scan results for its website. Change it in Settings.",
        );
      }
    } else {
      // Update display_name, website, website_host
      await admin
        .from("customer_brands")
        .update({
          display_name: val.display_name,
          website: val.website,
          website_host: val.website_host,
          aliases: val.aliases,
          updated_at: new Date().toISOString(),
        })
        .eq("brand_key", brandKey);
    }
  } else if (userMemberships.length > 0) {
    // User has another workspace and no onboarding row matching it
    throw new AppError(409, "already_has_workspace", "Your account already has a workspace.");
  } else {
    // Call create_customer_workspace RPC with idempotency key
    const rpcFn = deps?.createCustomerWorkspaceRpc
      ? (args: any) => deps!.createCustomerWorkspaceRpc!(admin, args)
      : (args: any) => admin.rpc("create_customer_workspace", args);

    const { data: rpcResult, error: rpcError } = await rpcFn({
      p_brand_key: val.brand_key,
      p_display_name: val.display_name,
      p_website: val.website,
      p_website_host: val.website_host,
      p_user_id: user.id,
      p_idempotency_key: `onboarding:${body.idempotencyKey}`,
      p_aliases: val.aliases,
    });

    if (rpcError) {
      if (rpcError.code === "23505") {
        throw new AppError(
          409,
          "workspace_exists",
          "This brand already has a workspace. Ask your Perceev contact to assign your account.",
        );
      }
      throw new AppError(500, "internal_error", "Could not create workspace.");
    }

    const parsedRpc = typeof rpcResult === "string" ? JSON.parse(rpcResult) : rpcResult;
    brandKey = parsedRpc?.brand_key ?? val.brand_key;
  }

  // 4. Require workspace membership
  const reqWsFn = deps?.requireWorkspace ?? defaultRequireWorkspace;
  const ws = await reqWsFn(request, { brandKey: brandKey! });

  // 5. Upsert user_onboarding row
  const at = new Date().toISOString();
  const existingSteps = (existingRow?.steps as Record<string, unknown> | null) ?? {};
  const updatedSteps = {
    ...existingSteps,
    website: { status: "done", at },
  };

  const existingHandoff = (existingRow?.handoff as Record<string, unknown> | null) ?? {};
  const updatedHandoff: Record<string, unknown> = {
    ...existingHandoff,
    ...(body.handoff?.domain !== undefined ? { domain: body.handoff.domain } : {}),
    ...(body.handoff?.scanId !== undefined ? { scanId: body.handoff.scanId } : {}),
  };

  await admin.from("user_onboarding").upsert(
    {
      user_id: user.id,
      brand_key: brandKey,
      steps: updatedSteps,
      handoff: updatedHandoff,
    },
    { onConflict: "user_id" },
  );

  // 6. Save market settings
  try {
    const saveSettings = deps?.saveQuestionSettings ?? defaultSaveQuestionSettings;
    await saveSettings(admin, {
      brandKey: brandKey!,
      settings: {
        country: body.country,
        language: body.language,
      },
      actor: user.id,
    });
  } catch (marketErr) {
    console.error(`[onboarding] market save failed ${brandKey}`, marketErr);
  }

  // 7. Free-scan import
  const handoffScanId = updatedHandoff.scanId as string | null | undefined;
  if (handoffScanId && !updatedHandoff.importedAt) {
    try {
      const importFn = deps?.importFreeScanQuestions ?? defaultImportFreeScanQuestions;
      const importResult = await importFn(admin, ws, handoffScanId, user.id);
      updatedHandoff.importedQuestions = importResult.imported;
      updatedHandoff.importedAt = new Date().toISOString();

      await admin
        .from("user_onboarding")
        .update({ handoff: updatedHandoff })
        .eq("user_id", user.id);

      if (importResult.imported > 0) {
        trackOnboardingServerEvent(
          "onboarding:free_scan_imported",
          { questions: importResult.imported },
          user.id,
        );
      }
    } catch (importErr) {
      console.error(`[onboarding] free scan import failed ${brandKey}`, importErr);
    }
  }

  // 8. Site audit
  const { data: existingAudit } = await admin
    .from("site_audits")
    .select("id")
    .eq("brand_key", brandKey)
    .limit(1)
    .maybeSingle();

  if (!existingAudit) {
    try {
      const startAuditFn = deps?.startSiteAudit ?? defaultStartSiteAudit;
      await startAuditFn(ws, {
        maxPages: 50,
        lighthouse: false,
        renderJavaScript: false,
        trigger: "baseline",
      });
      trackOnboardingServerEvent(
        "onboarding:audit_started",
        { started: true, reason: null },
        user.id,
      );
    } catch (auditErr: unknown) {
      const code =
        (auditErr as { code?: string })?.code ||
        (auditErr instanceof AppError ? auditErr.code : "unknown");
      console.error(`[onboarding] audit start failed ${brandKey} ${code}`, auditErr);
      trackOnboardingServerEvent(
        "onboarding:audit_started",
        { started: false, reason: code },
        user.id,
      );
    }
  }

  // 9. Return latest state
  const getState = deps?.getOnboardingState ?? defaultGetOnboardingState;
  return getState(admin, user, { scanId: body.handoff?.scanId, domain: body.handoff?.domain });
}
