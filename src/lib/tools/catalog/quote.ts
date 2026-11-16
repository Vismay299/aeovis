import { z } from "zod";
import { getPricedAction } from "../../pricing/pricedActions.ts";
import "../../pricing/actions/index.ts";

const ALWAYS_DROP = new Set([
  "maxUsd",
  "fetchId",
  "gridId",
  "requestId",
  "cacheOnly",
]);

/**
 * §6.2.5: pick only the tool-input keys the priced action declares, always drop
 * resumable/cache/free-collection fields, then let fixed fields win.
 */
export function actionQuoteInput(
  action: string,
  input: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const priced = getPricedAction(action);
  if (!priced) throw new Error("Unknown priced action: " + action);

  const schema = z.toJSONSchema(priced.input, { io: "input" }) as {
    properties?: Record<string, unknown>;
  };
  const properties = schema.properties ?? {};
  const quoteInput: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (ALWAYS_DROP.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      quoteInput[key] = input[key];
    }
  }

  return { ...quoteInput, ...extras };
}

export function readAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  };
}

export function writeAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  };
}

export function externalAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  };
}

export function paidAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  };
}
