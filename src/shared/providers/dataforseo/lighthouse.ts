// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/lighthouse.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { dataforseoPost, type DataforseoRequestOptions } from "./core.ts";
import { assertOk, buildTaskBilling, type DataforseoApiResponse } from "./envelope.ts";
import { ChargedCallError } from "../../spend/errors.ts";
import { meter } from "./client.ts";
import { dataforseoPricing } from "../../pricing/dataforseo.ts";
import {
  parseDataforseoLighthousePayload,
  type LighthouseStrategy,
  type StoredLighthousePayload,
} from "../../../server/audit/lighthousePayload.ts";

export type { LighthouseStrategy, StoredLighthousePayload };

export const requestCategories = [
  "performance",
  "accessibility",
  "best_practices",
  "seo",
] as const;

export const LIGHTHOUSE_PATH = "/v3/on_page/lighthouse/live/json";
const REQUEST_TIMEOUT_MS = 60_000;

let parseChain: Promise<unknown> = Promise.resolve();
function withParseLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = parseChain.then(fn, fn);
  parseChain = run.catch(() => {});
  return run;
}

export type LighthouseRequestOptions = Pick<DataforseoRequestOptions, "fetchImpl" | "env" | "baseUrl" | "signal">;

export async function fetchLighthouseResult(
  input: { url: string; strategy: LighthouseStrategy },
  options?: LighthouseRequestOptions,
): Promise<DataforseoApiResponse<StoredLighthousePayload>> {
  const body = await dataforseoPost(
    LIGHTHOUSE_PATH,
    [
      {
        url: input.url,
        for_mobile: input.strategy === "mobile",
        categories: [...requestCategories],
      },
    ],
    { timeoutMs: REQUEST_TIMEOUT_MS, fetchImpl: options?.fetchImpl, env: options?.env, baseUrl: options?.baseUrl, signal: options?.signal },
  );
  const task = assertOk(body);
  const billing = buildTaskBilling(task);
  try {
    const data = await withParseLock(async () => parseDataforseoLighthousePayload(body, input));
    return { data, billing };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ChargedCallError(message, {
      actualUsd: billing.costUsd,
      provider: "dataforseo",
      endpoint: LIGHTHOUSE_PATH,
      status: 502,
      code: "dataforseo_lighthouse_parse_failed",
      details: { providerCode: "dataforseo_lighthouse_parse_failed" },
    });
  }
}

export function createLighthouseClient(deps?: { metered?: typeof import("../../spend/index.ts").metered; spendDeps?: import("../../spend/index.ts").SpendDeps }) {
  const live = meter<{ url: string; strategy: LighthouseStrategy }, StoredLighthousePayload>(
    (input) => fetchLighthouseResult(input),
    () => dataforseoPricing.lighthouse.live({}),
    "site_audit.lighthouse" as never,
    deps as never,
  );
  return { live };
}
