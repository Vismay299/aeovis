import { z } from "zod";
import {
  definePricedAction,
  type PricingContext,
  type PricedActionEstimateResult,
} from "../pricedActions.ts";

export const contentDraftInput = z.strictObject({
  format: z.enum(["geo_article", "linkedin_post"]).default("geo_article"),
});

export type ContentDraftActionInput = z.infer<typeof contentDraftInput>;

/** The content pipeline's own per-item stop (`CONTENT_MAX_COST_PER_ITEM`, default 0.15). */
export function contentDraftCap(env: Record<string, string | undefined>): number {
  const configured = Number(env.CONTENT_MAX_COST_PER_ITEM);
  return Number.isFinite(configured) && configured > 0 ? configured : 0.15;
}

export async function estimateContentDraft(
  ctx: PricingContext,
  input: ContentDraftActionInput,
): Promise<PricedActionEstimateResult> {
  const cap = contentDraftCap(ctx.env);
  const line = {
    label: "Research, drafting and fact-checking for one draft",
    quantity: 1,
    unitUsd: cap,
    totalUsd: cap,
  };

  return {
    totalUsd: cap,
    expectedUsd: null,
    units: [],
    lines: [line],
    monthly: null,
    warnings: [
      {
        code: "cap_note",
        message:
          "The content pipeline checks this limit after each step, so a draft can pass it by the cost of one step.",
      },
    ],
    blocked: null,
  };
}

export const contentDraftAction = definePricedAction({
  key: "content.draft.run",
  feature: "content.draft",
  input: contentDraftInput,
  requireApproval: true,
  estimate: estimateContentDraft,
});
