// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-tools.ts:80-121, 258-588
//   src/server/mcp/tools/dataforseo-research-tools.ts:1050-1091
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { getLanguageCode, workspaceMarket } from "../../shared/keyword-locations.ts";
import { AppError } from "../http/appError.ts";
import { stableStringify } from "../cache/providerCache.ts";
import {
  fetchBusinessDataTaskResult,
  createBusinessClient,
  type BusinessTaskEndpoint,
} from "../providers/dataforseo/business.ts";
import { toResearchError } from "../research/providerErrors.ts";
import { AmbiguousCallError, ChargedCallError } from "../spend/errors.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { businessNotFound } from "./businesses.ts";
import {
  appendLocalResearch,
  fetchResearchFeature,
  fetchResearchKey,
  fetchResearchSummary,
} from "./research.ts";
import {
  BUSINESS_UPDATE_ROW_FIELDS,
  REVIEW_ROW_FIELDS,
  trimBusinessQuestionRow,
} from "./rowFields.ts";
import {
  businessIdentifierKeyword,
  formatBusinessDataCoordinate,
  pickRowFields,
  readPath,
} from "./shared.ts";
import {
  LOCAL_UNAVAILABLE_MESSAGE,
  localLog,
  localStoreFor,
  type BusinessRow,
  type FetchRow,
  type LocalDeps,
  type StoredFetchKind,
} from "./store.ts";

export const INLINE_POLL_ATTEMPTS = 5;
export const INLINE_POLL_INTERVAL_MS = 4000;
export const REUSE_WINDOW_MINUTES = 60;
export const FETCH_POLL_AFTER_SECONDS = 5;
const MAX_ITEMS = 200;
const FETCH_FAILED_MESSAGE = "Google data could not be collected. Try again later.";

export type FetchKind = StoredFetchKind;

export type FetchView = {
  id: string;
  kind: FetchKind;
  status: "processing" | "completed" | "failed";
  businessId: string | null;
  params: { depth: number; sortBy?: string; includeOtherSources?: boolean };
  totals: { reviewsCount?: number | null; rating?: number | null; title?: string | null } | null;
  items: unknown[] | null;
  itemCount: number;
  reused: boolean;
  error: { code: string; message: string } | null;
  createdAt: string;
  completedAt: string | null;
  pollAfterSeconds: number | null;
};

export type FetchSummary = {
  id: string;
  kind: FetchKind;
  status: FetchView["status"];
  itemCount: number;
  createdAt: string;
  params: FetchView["params"];
};

type Ws = Pick<Workspace, "brandKey" | "brand" | "admin" | "user">;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function endpointFor(kind: StoredFetchKind): BusinessTaskEndpoint {
  if (kind === "updates") return "my_business_updates";
  return kind === "extended_reviews" ? "extended_reviews" : "reviews";
}

function viewParams(row: FetchRow): FetchView["params"] {
  const p = row.params;
  const depth = typeof p.depth === "number" ? p.depth : 0;
  const out: FetchView["params"] = { depth };
  if (typeof p.sortBy === "string") out.sortBy = p.sortBy;
  if (typeof p.includeOtherSources === "boolean") out.includeOtherSources = p.includeOtherSources;
  return out;
}

async function toView(
  ws: Pick<Workspace, "brandKey" | "admin">,
  row: FetchRow,
  deps: LocalDeps | undefined,
  reused: boolean,
): Promise<FetchView> {
  const completed = row.status === "completed";
  const items = completed ? await localStoreFor(ws, deps).getFetchItems(ws.brandKey, row.id) : null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    businessId: row.business_id,
    params: viewParams(row),
    totals: (row.totals as FetchView["totals"]) ?? null,
    items,
    itemCount: row.item_count,
    reused,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? FETCH_FAILED_MESSAGE } : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    pollAfterSeconds: row.status === "processing" ? FETCH_POLL_AFTER_SECONDS : null,
  };
}

function trimItems(kind: StoredFetchKind, raw: unknown[]): Record<string, unknown>[] {
  return raw.slice(0, MAX_ITEMS).map((item) => {
    if (kind === "updates") return pickRowFields(item, BUSINESS_UPDATE_ROW_FIELDS);
    if (kind === "questions") return trimBusinessQuestionRow(item);
    return pickRowFields(item, REVIEW_ROW_FIELDS);
  });
}

function totalsFromResult(result: Record<string, unknown> | null): Record<string, unknown> {
  const title = readPath(result, "title");
  const reviewsCount = readPath(result, "reviews_count");
  const rating = readPath(result, "rating", "value");
  return {
    title: typeof title === "string" ? title.slice(0, 300) : null,
    reviewsCount: typeof reviewsCount === "number" ? reviewsCount : null,
    rating: typeof rating === "number" ? rating : null,
  };
}

async function businessFor(ws: Pick<Workspace, "brandKey" | "admin">, row: FetchRow, deps?: LocalDeps) {
  if (!row.business_id) return null;
  return localStoreFor(ws, deps).getBusiness(ws.brandKey, row.business_id);
}

/** Stores items, flips the row to completed and writes the research-log entry (once). */
async function completeFetch(
  ws: Ws,
  row: FetchRow,
  items: unknown[],
  totals: Record<string, unknown> | null,
  deps: LocalDeps | undefined,
): Promise<FetchRow> {
  const store = localStoreFor(ws, deps);
  const trimmed = trimItems(row.kind, items);
  await store.upsertFetchItems(ws.brandKey, row.id, trimmed);
  const completedAt = new Date((deps?.now ?? Date.now)()).toISOString();
  await store.updateFetch(ws.brandKey, row.id, {
    status: "completed",
    totals,
    item_count: trimmed.length,
    error_code: null,
    error_message: null,
    completed_at: completedAt,
  });
  const business = await businessFor(ws, row, deps);
  const title = (typeof totals?.title === "string" ? totals.title : null) ?? business?.title ?? null;
  const total = typeof totals?.reviewsCount === "number" ? totals.reviewsCount : null;
  await appendLocalResearch(
    ws,
    {
      kind: fetchResearchFeature(row.kind),
      researchKey: fetchResearchKey({
        kind: row.kind,
        cid: business?.cid ?? (row.identifier.cid as string | undefined),
        placeId: business?.place_id ?? (row.identifier.placeId as string | undefined),
        depth: viewParams(row).depth,
      }),
      summary: fetchResearchSummary({ kind: row.kind, title, collected: trimmed.length, total }),
    },
    deps,
  );
  localLog(deps, `[local] fetch ${row.id} ${row.kind} completed`);
  return { ...row, status: "completed", totals, item_count: trimmed.length, completed_at: completedAt };
}

async function failFetch(ws: Ws, row: FetchRow, code: string, message: string, deps?: LocalDeps): Promise<FetchRow> {
  const completedAt = new Date((deps?.now ?? Date.now)()).toISOString();
  await localStoreFor(ws, deps).updateFetch(ws.brandKey, row.id, {
    status: "failed",
    error_code: code,
    error_message: message.slice(0, 300),
    completed_at: completedAt,
  });
  localLog(deps, `[local] fetch ${row.id} ${row.kind} failed`);
  return { ...row, status: "failed", error_code: code, error_message: message.slice(0, 300), completed_at: completedAt };
}

export function fetchParamsHash(input: {
  kind: StoredFetchKind;
  identifier: Record<string, unknown>;
  depth: number;
  sortBy?: string;
  coordinate: string;
}): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export type FetchPlan = {
  identifier: Record<string, unknown>;
  coordinate: string | null;
  /** The market fallback used when the business has no coordinate; null when none was available. */
  locationCode: number | null;
  languageCode: string;
  kind: StoredFetchKind;
  sortBy: string | undefined;
  includeOtherSources: boolean;
  /** Exact reuse hash; null when the location cannot be resolved without the workspace market. */
  hash: string | null;
};

/**
 * The one derivation of a fetch's identifier, location, stored kind, sort and reuse hash.
 * `startFetch` and the quote (`quoteDeps.ts`) both call it, so a quote of 0 is only given
 * when the service will find the same reuse row. Returns null when the business has no
 * CID or place ID.
 */
export function planFetch(
  business: Pick<BusinessRow, "cid" | "place_id" | "latitude" | "longitude" | "location_code" | "language_code">,
  i: { kind: "reviews" | "updates" | "questions"; depth: number; sortBy?: string; includeOtherSources?: boolean },
  fallbackLocationCode: number | null,
): FetchPlan | null {
  if (!business.cid && !business.place_id) return null;
  const identifier: Record<string, unknown> = business.cid ? { cid: business.cid } : { placeId: business.place_id };
  const coordinate =
    business.latitude != null && business.longitude != null
      ? formatBusinessDataCoordinate({ latitude: business.latitude, longitude: business.longitude })
      : null;
  const locationCode = business.location_code ?? fallbackLocationCode;
  // Reviews from other sites use the extended endpoint and cannot be sorted.
  const includeOtherSources = i.kind === "reviews" && i.includeOtherSources === true;
  const kind: StoredFetchKind = includeOtherSources ? "extended_reviews" : i.kind;
  const sortBy = kind === "reviews" ? (i.sortBy ?? "newest") : undefined;
  const where = coordinate ?? (locationCode != null ? `code:${locationCode}` : null);
  return {
    identifier,
    coordinate,
    locationCode,
    languageCode: business.language_code || (locationCode != null ? getLanguageCode(locationCode) : "en"),
    kind,
    sortBy,
    includeOtherSources,
    hash: where === null ? null : fetchParamsHash({ kind, identifier, depth: i.depth, sortBy, coordinate: where }),
  };
}

export async function startFetch(
  ws: Ws,
  i: {
    kind: "reviews" | "updates" | "questions";
    businessId: string;
    depth: number;
    sortBy?: "newest" | "highest_rating" | "lowest_rating" | "relevant";
    includeOtherSources?: boolean;
    maxUsd?: number;
    requestId: string;
  },
  deps?: LocalDeps,
): Promise<FetchView> {
  const store = localStoreFor(ws, deps);
  const nowMs = deps?.now ?? Date.now;
  const sleep = deps?.sleep ?? defaultSleep;

  // 1. The business must be saved in this workspace; the identifier is never a name.
  const business: BusinessRow | null = await store.getBusiness(ws.brandKey, i.businessId);
  if (!business) throw businessNotFound();
  const plan = planFetch(business, i, workspaceMarket(ws.brand).locationCode);
  if (!plan || plan.hash === null) {
    throw new AppError(400, "identifier_required", "Provide exactly one business identifier: name, CID or place ID.");
  }
  const { identifier, coordinate, languageCode, kind, sortBy, includeOtherSources, hash } = plan;
  const locationCode = plan.locationCode as number;
  if (i.kind === "questions" && !coordinate) {
    throw new AppError(400, "business_location_required", "Load the full profile first so we know where the business is.");
  }
  const location = coordinate ? { locationCoordinate: coordinate } : { locationCode };

  // 2. Reuse within the window: no spend (the hash covers kind, identifier, depth, sort and location).
  const since = new Date(nowMs() - REUSE_WINDOW_MINUTES * 60_000).toISOString();
  const reuseId = await store.findReuse(ws.brandKey, "fetch", hash, since);
  if (reuseId) {
    const reusedRow = await store.getFetch(ws.brandKey, reuseId);
    if (reusedRow) return toView(ws, reusedRow, deps, true);
  }

  // 3. Insert; a repeated requestId returns the existing row without buying again.
  const params: Record<string, unknown> = { depth: i.depth };
  if (sortBy) params.sortBy = sortBy;
  if (kind === "reviews" || kind === "extended_reviews") params.includeOtherSources = includeOtherSources;
  const inserted = await store.insertFetch({
    brandKey: ws.brandKey,
    requestId: i.requestId,
    businessId: business.id,
    kind,
    identifier,
    params,
    paramsHash: hash,
    requestedBy: ws.user.id,
  });
  if (!inserted.created) return toView(ws, inserted.row, deps, false);
  let row = inserted.row;
  const callCtx = (action: string) => ({
    brandKey: ws.brandKey,
    idempotencyKey: `local.${action}:${i.requestId}`,
    maxUsd: i.maxUsd,
  });
  const client = deps?.business ?? createBusinessClient();
  const keyword = businessIdentifierKeyword(identifier);

  // Only the paid call is guarded: a charged failure keeps a failed row, an unbilled one drops it.
  async function paid<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; view: FetchView }> {
    try {
      return { ok: true, value: await call() };
    } catch (err) {
      if (err instanceof ChargedCallError || err instanceof AmbiguousCallError) {
        const failed = await failFetch(ws, row, "local_fetch_failed", FETCH_FAILED_MESSAGE, deps);
        return { ok: false, view: await toView(ws, failed, deps, false) };
      }
      // Nothing was billed: drop the placeholder row and report the error.
      await store.deleteFetch(ws.brandKey, row.id);
      throw toResearchError(err, {
        unavailableCode: "local_unavailable",
        unavailableMessage: LOCAL_UNAVAILABLE_MESSAGE,
      });
    }
  }

  if (kind === "questions") {
    // 5. Live call; answered and unanswered questions are already combined.
    const outcome = await paid(() =>
      client.questionsAnswers(
        { ...callCtx("questions"), feature: "local.business" },
        { keyword, locationCoordinate: coordinate as string, languageCode, depth: i.depth },
      ),
    );
    if (!outcome.ok) return outcome.view;
    row = await completeFetch(ws, row, outcome.value, null, deps);
    return toView(ws, row, deps, false);
  }

  // 6. Queued post: store the provider task id before polling so the purchase is never lost.
  const posted = await paid(() =>
    kind === "updates"
      ? client.updatesTaskPost(
          { ...callCtx("updates"), feature: "local.business" },
          { keyword, ...location, languageCode, depth: i.depth },
        )
      : client.reviewsTaskPost(
          { ...callCtx(kind), feature: "local.reviews" },
          {
            cid: business.cid ?? undefined,
            placeId: business.cid ? undefined : (business.place_id ?? undefined),
            ...location,
            languageCode,
            depth: i.depth,
            sortBy: includeOtherSources ? undefined : sortBy,
            includeOtherSources,
          },
        ),
  );
  if (!posted.ok) return posted.view;
  await store.updateFetch(ws.brandKey, row.id, { provider_task_id: posted.value });
  row = { ...row, provider_task_id: posted.value };

  // Inline polling: wait, then read, up to INLINE_POLL_ATTEMPTS x INLINE_POLL_INTERVAL_MS.
  const fetchTask = deps?.fetchTaskResult ?? fetchBusinessDataTaskResult;
  for (let attempt = 1; attempt <= INLINE_POLL_ATTEMPTS; attempt += 1) {
    await sleep(INLINE_POLL_INTERVAL_MS);
    try {
      const outcome = await fetchTask({ endpoint: endpointFor(kind), taskId: row.provider_task_id as string });
      if (outcome.status === "completed") {
        const items = (readPath(outcome.result, "items") as unknown[] | null) ?? [];
        row = await completeFetch(ws, row, Array.isArray(items) ? items : [], totalsFromResult(outcome.result), deps);
        return toView(ws, row, deps, false);
      }
    } catch (err) {
      if (isProviderTaskFailure(err)) {
        row = await failFetch(ws, row, "dataforseo_task_failed", err.message, deps);
        return toView(ws, row, deps, false);
      }
      // A collection error keeps the fetch collectable: the next GET retries for free.
      break;
    }
  }
  localLog(deps, `[local] fetch ${row.id} ${row.kind} processing`);
  return toView(ws, row, deps, false);
}

function isProviderTaskFailure(err: unknown): err is AppError {
  return err instanceof AppError && err.code === "dataforseo_task_failed";
}

export async function collectFetch(ws: Ws, fetchId: string, deps?: LocalDeps): Promise<FetchView> {
  const store = localStoreFor(ws, deps);
  let row = await store.getFetch(ws.brandKey, fetchId);
  if (!row) throw new AppError(404, "fetch_not_found", "That collection was not found.");
  if (row.status !== "processing" || !row.provider_task_id) return toView(ws, row, deps, false);

  if (!(await store.claimPoll(ws.brandKey, "fetch", row.id))) return toView(ws, row, deps, false);

  const fetchTask = deps?.fetchTaskResult ?? fetchBusinessDataTaskResult;
  try {
    const outcome = await fetchTask({ endpoint: endpointFor(row.kind), taskId: row.provider_task_id });
    if (outcome.status === "completed") {
      const items = (readPath(outcome.result, "items") as unknown[] | null) ?? [];
      row = await completeFetch(ws, row, Array.isArray(items) ? items : [], totalsFromResult(outcome.result), deps);
    }
  } catch (err) {
    if (isProviderTaskFailure(err)) {
      row = await failFetch(ws, row, "dataforseo_task_failed", err.message, deps);
    }
    // Any other error is transient: the fetch stays processing.
  }
  return toView(ws, row, deps, false);
}

export async function listFetches(
  ws: Pick<Workspace, "brandKey" | "admin">,
  i: { businessId?: string; kind?: FetchKind; limit: number },
  deps?: LocalDeps,
): Promise<FetchSummary[]> {
  const rows = await localStoreFor(ws, deps).listFetches(ws.brandKey, i);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    itemCount: row.item_count,
    createdAt: row.created_at,
    params: viewParams(row),
  }));
}
