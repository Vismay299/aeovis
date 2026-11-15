import { z } from "zod";
import { priceQuoteSchema } from "../../../shared/pricing.ts";
import "../../pricing/actions/index.ts";
import { quote } from "../../pricing/pricedActions.ts";
import type { ToolDefinition, ToolHandlerContext } from "../types.ts";

const input = z.strictObject({
  action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  input: z.record(z.string(), z.unknown()),
});

export const estimatePriceTool: ToolDefinition = {
  name: "estimate_price",
  description: "Estimate the current price for a supported action without running it.",
  input,
  output: priceQuoteSchema,
  handler: async (ctx: ToolHandlerContext, raw) => {
    const parsed = input.parse(raw);

    return quote(
      parsed.action,
      {
        brandKey: ctx.brand.brandKey,
        admin: ctx.admin,
        env: process.env,
        now: new Date(),
      },
      parsed.input,
    );
  },
};
