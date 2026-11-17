import type { SupabaseClient } from "@supabase/supabase-js";
import type { OnboardingStep, StepStatus } from "../../shared/onboarding.ts";
import { trackOnboardingServerEvent } from "./telemetry.ts";

export async function recordStep(
  admin: SupabaseClient,
  userId: string,
  step: OnboardingStep,
  status: StepStatus,
): Promise<{ steps: Record<string, { status: StepStatus; at: string }> }> {
  const at = new Date().toISOString();

  // Read existing row to preserve existing steps
  const { data: existing } = await admin
    .from("user_onboarding")
    .select("steps")
    .eq("user_id", userId)
    .maybeSingle();

  const currentSteps = (existing?.steps as Record<string, { status: StepStatus; at: string }> | null) ?? {};
  const updatedSteps = {
    ...currentSteps,
    [step]: { status, at },
  };

  const { error } = await admin.from("user_onboarding").upsert(
    {
      user_id: userId,
      steps: updatedSteps,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    throw error;
  }

  return { steps: updatedSteps };
}

export async function completeOnboarding(
  admin: SupabaseClient,
  userId: string,
  via: "wizard" | "first_scan" | "skipped",
): Promise<{ completedNow: boolean; completedAt: string; via: string }> {
  const { data: existing } = await admin
    .from("user_onboarding")
    .select("completed_at, completed_via, steps")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing?.completed_at) {
    return {
      completedNow: false,
      completedAt: String(existing.completed_at),
      via: String(existing.completed_via ?? via),
    };
  }

  const now = new Date().toISOString();
  const { error } = await admin.from("user_onboarding").upsert(
    {
      user_id: userId,
      completed_at: now,
      completed_via: via,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    throw error;
  }

  const steps = (existing?.steps as Record<string, { status: string }> | null) ?? {};
  const stepsDone = Object.values(steps).filter((s) => s?.status === "done").length;
  const stepsSkipped = Object.values(steps).filter((s) => s?.status === "skipped").length;

  trackOnboardingServerEvent(
    "onboarding:completed",
    {
      via,
      steps_done: stepsDone,
      steps_skipped: stepsSkipped,
    },
    userId,
  );

  return {
    completedNow: true,
    completedAt: now,
    via,
  };
}
