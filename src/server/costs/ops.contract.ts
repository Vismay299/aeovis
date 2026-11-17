/**
 * F03 §6.5 — the wire contract for the operator cost routes.
 *
 * These routes are operator-only: the perimeter refuses a request without the
 * operator token before the route ever runs. The contract records the shape of
 * the data, not the gate.
 */

import { z } from "zod";
import { defineRouteContract } from "../../shared/http/routeContract.ts";
import type { RouteContract } from "../../shared/http/routeContract.ts";

const COSTS_FILE = "src/app/api/ops/costs/route.ts";
const RESOLVE_FILE = "src/app/api/ops/costs/reconciliations/[id]/route.ts";
const BULK_FILE = "src/app/api/ops/costs/reconciliations/bulk/route.ts";

/** §6.5 GET query. Closed: an unknown query parameter is a client error. */
export const opsCostsQuery = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const opsResolveBody = z.strictObject({
  resolution: z.enum(["accepted", "price_updated", "not_billed"]),
  note: z.string().min(10).max(500),
});

export const opsBulkBody = z.strictObject({
  kind: z.literal("unknown_cost"),
  beforeDays: z.int().min(1).max(400),
  note: z.string().min(10).max(500),
  limit: z.int().min(1).max(5000).default(1000),
});

export const opsCostsResponse = z.looseObject({
  byWorkspace: z.array(
    z.looseObject({
      brandKey: z.string(),
      feature: z.string(),
      accountedUsd: z.number().min(0),
      knownUsd: z.number().min(0),
      unknownUsd: z.number().min(0),
      calls: z.int().min(0),
      openReconciliations: z.int().min(0),
    })
  ),
  byEndpoint: z.array(
    z.looseObject({
      provider: z.string(),
      endpoint: z.string(),
      calls: z.int().min(0),
      estimateUsd: z.number().min(0),
      actualUsd: z.number().min(0),
      unknownCalls: z.int().min(0),
      undershoots: z.int().min(0),
      maxRatio: z.number().nullable(),
    })
  ),
  openHolds: z.array(
    z.looseObject({
      holdId: z.string(),
      brandKey: z.string(),
      feature: z.string(),
      estimateUsd: z.number().min(0),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      subjectKind: z.string().nullable(),
      subjectId: z.string().nullable(),
    })
  ),
  reconciliations: z.array(
    z.looseObject({
      id: z.string(),
      brandKey: z.string(),
      feature: z.string(),
      provider: z.string(),
      endpoint: z.string(),
      kind: z.string(),
      estimateUsd: z.number().nullable(),
      actualUsd: z.number().nullable(),
      priceVersion: z.string().nullable(),
      createdAt: z.iso.datetime(),
      isProbe: z.boolean(),
    })
  ),
  engineStats: z.array(
    z.looseObject({
      engine: z.string(),
      samples: z.int().min(0),
      medianUsd: z.number().nullable(),
      p90Usd: z.number().nullable(),
    })
  ),
  priceVersion: z.string(),
});

export const opsResolvedResponse = z.looseObject({ resolved: z.boolean() });

export const opsBulkResolvedResponse = z.looseObject({ resolved: z.int().min(0) });

const EXAMPLE_COSTS = {
  byWorkspace: [
    {
      brandKey: "offcult.in",
      feature: "ai_visibility.scan",
      accountedUsd: 7.412,
      knownUsd: 7.012,
      unknownUsd: 0.4,
      calls: 122,
      openReconciliations: 2,
    },
  ],
  byEndpoint: [
    {
      provider: "openrouter",
      endpoint: "probe:chatgpt",
      calls: 122,
      estimateUsd: 8,
      actualUsd: 7.012,
      unknownCalls: 2,
      undershoots: 0,
      maxRatio: 0.88,
    },
  ],
  openHolds: [
    {
      holdId: "0f2a-hold",
      brandKey: "offcult.in",
      feature: "ai_visibility.scan",
      estimateUsd: 1,
      createdAt: "2026-10-21T08:00:00.000Z",
      expiresAt: "2026-10-22T08:00:00.000Z",
      subjectKind: "scan_job",
      subjectId: "0c2a-job",
    },
  ],
  reconciliations: [
    {
      id: "9a7c-reconciliation",
      brandKey: "offcult.in",
      feature: "ai_visibility.scan",
      provider: "openrouter",
      endpoint: "probe:gemini",
      kind: "unknown_cost",
      estimateUsd: 0.2,
      actualUsd: null,
      priceVersion: "2026-10-21.1",
      createdAt: "2026-10-21T08:05:00.000Z",
      isProbe: true,
    },
  ],
  engineStats: [{ engine: "chatgpt", samples: 24, medianUsd: 0.004, p90Usd: 0.009 }],
  priceVersion: "2026-10-21.1",
};

export const contracts: RouteContract[] = [
  defineRouteContract({
    id: "ops.costs.get",
    method: "GET",
    path: "/api/ops/costs",
    file: COSTS_FILE,
    auth: "operator",
    query: opsCostsQuery,
    response: opsCostsResponse,
    errorCodes: ["invalid_request", "invalid_range", "storage_unavailable", "costs_unavailable"],
    examples: [{ response: EXAMPLE_COSTS }],
  }),
  defineRouteContract({
    id: "ops.costs.reconciliations.resolve",
    method: "POST",
    path: "/api/ops/costs/reconciliations/[id]",
    file: RESOLVE_FILE,
    auth: "operator",
    request: opsResolveBody,
    response: opsResolvedResponse,
    errorCodes: [
      "invalid_json",
      "invalid_request",
      "note_required",
      "reconciliation_not_found",
      "use_probe_reconciliation",
      "not_unknown_cost",
      "storage_unavailable",
    ],
    examples: [{ response: { resolved: true } }],
  }),
  defineRouteContract({
    id: "ops.costs.reconciliations.bulk",
    method: "POST",
    path: "/api/ops/costs/reconciliations/bulk",
    file: BULK_FILE,
    auth: "operator",
    request: opsBulkBody,
    response: opsBulkResolvedResponse,
    errorCodes: [
      "invalid_json",
      "invalid_request",
      "note_required",
      "not_unknown_cost",
      "storage_unavailable",
    ],
    examples: [{ response: { resolved: 12 } }],
  }),
];
