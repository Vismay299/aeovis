/**
 * F07 §6.5 — the wire contract for `/api/customer/context`. Own code.
 *
 * The repo-wide harness (`src/lib/http/routeContract.test.ts`) imports this
 * file, requires a loose response with at least one parsing example, closed
 * request/query schemas, and a handler named `method` on `file`.
 */

import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";
import type { RouteContract } from "../http/routeContract.ts";
import { projectContextSchema, updateProjectContextBody } from "../../shared/project-context.ts";

const ROUTE_FILE = "src/app/api/customer/context/route.ts";

/** §6.5 GET query. Closed: an unknown query parameter is a client error. */
export const contextGetQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

const EXAMPLE_CONTEXT = {
  brandKey: "offcult.in",
  sections: [
    {
      key: "business_overview",
      content: "Oversized and heavyweight T-shirts with anime graphics, sold online across India.",
      updatedAt: "2026-10-21T09:12:00.000Z",
      updatedBy: "user",
      updatedByUser: "6f1c2a1e-3d5b-4f7a-9c8e-0b2d4f6a8c1e",
    },
  ],
  missingSections: ["current_goal", "positioning", "writing_preferences"],
  customSections: [
    {
      slug: "priority-topics",
      title: "Priority topics",
      content: "- Anime streetwear",
      updatedAt: "2026-10-21T09:12:00.000Z",
      updatedBy: "system",
      updatedByUser: null,
    },
  ],
  competitors: [
    {
      id: "1b7e5c44-9f3a-4d21-8b6e-2c4f7a9d1e35",
      domain: "bewakoof.com",
      name: "Bewakoof",
      notes: null,
      source: "setup_research",
      sourceUrl: "https://bewakoof.com/men-oversized-t-shirts",
      updatedAt: "2026-10-21T09:12:00.000Z",
      updatedBy: "user",
      updatedByUser: "6f1c2a1e-3d5b-4f7a-9c8e-0b2d4f6a8c1e",
    },
  ],
  keyPages: [
    {
      id: "9d2a4b17-6c8e-4d3f-9a1b-2e4c6f8a0d35",
      url: "https://offcult.in/collections/oversized-tees",
      role: "money",
      topic: "oversized t-shirts",
      notes: null,
      updatedAt: "2026-10-21T09:12:00.000Z",
      updatedBy: "user",
      updatedByUser: "6f1c2a1e-3d5b-4f7a-9c8e-0b2d4f6a8c1e",
    },
  ],
  researchLog: [
    {
      id: "c3f0a8d2-4b6e-4a1c-8f5d-7e9b1c3a5f27",
      entryDate: "2026-10-21",
      kind: "platform.selftest",
      researchKey: "offcult.in",
      summary: "Website research: overview, 5 competitors checked, 25 draft questions.",
      spendUsd: 0.0841,
      createdBy: "system",
    },
  ],
  researchLogLimited: false,
  brandIdentity: {
    displayName: "Offcult",
    website: "https://offcult.in",
    matchNames: ["Offcult", "offcult"],
  },
};

/**
 * The status/code pairs §6.5 lists, plus the codes `requireWorkspace` can answer
 * with. `owner_required` is absent because neither route asks for a role:
 * members read and edit memory.
 */
const GET_ERROR_CODES = [
  "invalid_request",
  "auth_not_configured",
  "unauthenticated",
  "membership_unavailable",
  "workspace_not_found",
  "storage_unavailable",
  "feature_unavailable",
  "context_unavailable",
];

const PATCH_ERROR_CODES = [
  ...GET_ERROR_CODES,
  "cross_site",
  "context_invalid",
  "context_cap",
];

export const contextGetContract = defineRouteContract({
  id: "customer.context.get",
  method: "GET",
  path: "/api/customer/context",
  file: ROUTE_FILE,
  auth: "workspace",
  query: contextGetQuery,
  response: projectContextSchema,
  errorCodes: GET_ERROR_CODES,
  examples: [{ response: EXAMPLE_CONTEXT }],
});

export const contextPatchContract = defineRouteContract({
  id: "customer.context.patch",
  method: "PATCH",
  path: "/api/customer/context",
  file: ROUTE_FILE,
  auth: "workspace",
  query: contextGetQuery,
  request: updateProjectContextBody,
  response: projectContextSchema,
  errorCodes: PATCH_ERROR_CODES,
  // The harness types an example as `{ response }` only, so the §6.5 request
  // example (`updateProjectContextBody`) is proven by
  // `src/lib/projectContext/context.route.test.mjs` instead of being smuggled in.
  examples: [{ response: EXAMPLE_CONTEXT }],
});

export const contracts: RouteContract[] = [contextGetContract, contextPatchContract];
