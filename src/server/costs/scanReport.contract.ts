/**
 * F03 §6.5 — the wire contract for `GET /api/customer/scan/report/[scan_id]`.
 *
 * The route existed before this contract: the response keeps every field it
 * always had, and the scan gains `cost` while each result row gains its own
 * `cost`. The response is loose at every level, so the existing fields stay
 * permitted and a later field may be added without breaking a client.
 */

import { z } from "zod";
import { defineRouteContract } from "../../shared/http/routeContract.ts";
import type { RouteContract } from "../../shared/http/routeContract.ts";

const ROUTE_FILE = "src/app/api/customer/scan/report/[scan_id]/route.ts";

export const scanCostSchema = z.looseObject({
  state: z.enum(["final", "running", "unavailable"]),
  jobId: z.string().nullable(),
  answers: z.int().min(0),
  attempts: z.int().min(0),
  knownUsd: z.number().min(0),
  unknownAttempts: z.int().min(0),
  reservedUnknownUsd: z.number().min(0),
  totalAccountedUsd: z.number().min(0),
  perAnswerUsd: z.number().nullable(),
  byEngine: z.array(
    z.looseObject({
      engine: z.string(),
      label: z.string(),
      answers: z.int().min(0),
      attempts: z.int().min(0),
      knownUsd: z.number().min(0),
      unknownAttempts: z.int().min(0),
      perAnswerUsd: z.number().nullable(),
    })
  ),
  heldUsd: z.number().nullable(),
});

/** The cost of one result row, joined by `raw.observation_id`. */
export const answerCostSchema = z.looseObject({
  usd: z.number().nullable(),
  attempts: z.int().min(0),
  unknownAttempts: z.int().min(0),
});

export const scanReportResponse = z.looseObject({
  scan: z.looseObject({
    id: z.string(),
    brand: z.string().nullable(),
    url: z.string().nullable(),
    scanned_at: z.string().nullable(),
    created_at: z.string().nullable(),
    visibility_pct: z.number().nullable(),
    summary_stats: z.unknown(),
    prompts_tracked: z.number().nullable(),
    prompts_mentioned: z.number().nullable(),
    platform: z.unknown(),
    engines: z.unknown(),
    planned_questions: z.unknown(),
    engine_scores: z.unknown(),
    competitors: z.unknown(),
    share_of_voice_pct: z.number().nullable(),
    win_rate_pct: z.number().nullable(),
    brand_citation_share_pct: z.number().nullable(),
    cost: scanCostSchema,
  }),
  results: z.array(
    z.looseObject({
      id: z.string(),
      query: z.string(),
      engine: z.string(),
      answer_text: z.string().nullable(),
      answered: z.boolean().nullable(),
      mentioned: z.boolean().nullable(),
      brand_cited: z.boolean().nullable(),
      position: z.number().nullable(),
      sentiment: z.string().nullable(),
      raw: z.unknown(),
      created_at: z.string().nullable(),
      cost: answerCostSchema.nullable(),
    })
  ),
});

/** §6.5's example, with the truncated parts filled in so it parses. */
const EXAMPLE_REPORT = {
  scan: {
    id: "0c2a-scan",
    brand: "Offcult",
    url: "https://offcult.in",
    scanned_at: "2026-10-21T09:00:00.000Z",
    created_at: "2026-10-21T09:00:00.000Z",
    visibility_pct: 42,
    summary_stats: { engines: 4 },
    prompts_tracked: 120,
    prompts_mentioned: 50,
    platform: ["aio", "chatgpt", "gemini", "perplexity"],
    engines: { aio: { error_rate_pct: 0 } },
    planned_questions: ["best running shoes"],
    engine_scores: { chatgpt: 40 },
    competitors: ["bewakoof.com"],
    share_of_voice_pct: 18.5,
    win_rate_pct: 42,
    brand_citation_share_pct: 12,
    cost: {
      state: "final",
      jobId: "0c2a-job",
      answers: 116,
      attempts: 124,
      knownUsd: 6.912,
      unknownAttempts: 2,
      reservedUnknownUsd: 0.4,
      totalAccountedUsd: 7.312,
      perAnswerUsd: null,
      byEngine: [
        {
          engine: "chatgpt",
          label: "ChatGPT",
          answers: 32,
          attempts: 33,
          knownUsd: 2.21,
          unknownAttempts: 0,
          perAnswerUsd: 0.0691,
        },
      ],
      heldUsd: null,
    },
  },
  results: [
    {
      id: "result-a",
      query: "best running shoes",
      engine: "chatgpt",
      answer_text: "An answer",
      answered: true,
      mentioned: true,
      brand_cited: false,
      position: 1,
      sentiment: "positive",
      raw: { observation_id: "obs-a" },
      created_at: "2026-10-21T09:00:00.000Z",
      cost: { usd: 0.0691, attempts: 1, unknownAttempts: 0 },
    },
  ],
};

/**
 * The status/code pairs §6.5 lists, plus the codes `requireWorkspace` can answer
 * with. The messages are the route's own: this conversion must not change a
 * customer-visible string.
 */
const ERROR_CODES = [
  "invalid_request",
  "auth_not_configured",
  "unauthenticated",
  "membership_unavailable",
  "storage_unavailable",
  "scan_not_found",
  "internal_error",
];

export const scanReportContract = defineRouteContract({
  id: "customer.scan.report.get",
  method: "GET",
  path: "/api/customer/scan/report/[scan_id]",
  file: ROUTE_FILE,
  auth: "workspace",
  response: scanReportResponse,
  errorCodes: ERROR_CODES,
  examples: [{ response: EXAMPLE_REPORT }],
});

export const contracts: RouteContract[] = [scanReportContract];
