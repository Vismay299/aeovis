import { z } from "zod";

export const priceQuoteSchema = z.looseObject({
  action: z.string(),
  currency: z.literal("USD"),
  totalUsd: z.number().min(0), // what the run may reserve; the amount the customer approves
  expectedUsd: z.number().min(0).nullable(), // typical cost; null when unknown. Never approved.
  units: z.array(
    z.looseObject({
      key: z.string(),
      label: z.string(),
      count: z.int().min(0),
    }),
  ),
  lines: z.array(
    z.looseObject({
      label: z.string(),
      quantity: z.int().min(0),
      unitUsd: z.number().min(0),
      totalUsd: z.number().min(0),
    }),
  ),
  monthly: z
    .looseObject({
      interval: z.enum(["daily", "weekly", "monthly"]),
      runsPerMonth: z.int().min(1),
      totalUsd: z.number().min(0),
    })
    .nullable(),
  warnings: z.array(
    z.looseObject({
      code: z.string(),
      message: z.string(),
    }),
  ),
  blocked: z
    .looseObject({
      code: z.string(),
      message: z.string(),
      recovery: z.string().optional(),
    })
    .nullable(),
  priceVersion: z.string(),
  quotedAt: z.iso.datetime(),
  inputsHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type PriceQuote = z.infer<typeof priceQuoteSchema>;

export function quoteExceeds(freshUsd: number, approvedMaxUsd: number): boolean {
  return Math.round(freshUsd * 1e6) > Math.round(approvedMaxUsd * 1e6);
}

export { formatUsd } from "./money.ts";
