import { z } from "zod";
import { definePricedAction, type PricingContext, type PricedActionEstimateResult } from "../pricedActions.ts";
import { SCHEDULE_INTERVALS } from "../../../shared/schedule.ts";
import { estimateScanRun, type ScanQuoteDeps } from "./scanRun.ts";

export const scheduleSaveInput = z.strictObject({
  panelKey: z.string().min(1).max(80).default("default"),
  scheduleInterval: z.enum(SCHEDULE_INTERVALS),
});

export const SCHEDULE_NOTE_WARNING = {
  code: "schedule_note",
  message: "Each scheduled scan reserves up to this amount and is charged only for answers collected.",
} as const;

export async function estimateScheduleSave(
  ctx: PricingContext,
  input: z.infer<typeof scheduleSaveInput>,
  deps?: ScanQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const quote = await estimateScanRun(
    ctx,
    { panelKey: "default", scheduleInterval: input.scheduleInterval },
    deps,
  );
  return {
    ...quote,
    warnings: [...quote.warnings, { ...SCHEDULE_NOTE_WARNING }],
  };
}

export const scheduleSaveAction = definePricedAction({
  key: "ai_visibility.schedule.save",
  feature: "ai_visibility.scan",
  input: scheduleSaveInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateScheduleSave(ctx, input),
});
