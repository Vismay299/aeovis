// Live inputs for the F17 priced-action quotes (F17 §6.2.9, F17-AC-12): the
// `recent_research` warning, zero totals for a reused fetch or a cached listings
// search, and the 20-grids-per-day block. The registered estimates in
// src/lib/pricing/actions/local.ts call these with the quote's workspace admin
// client. Every lookup fails soft: a quote never errors because a hint was
// unavailable, it just shows the full price without the hint.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LocalPricingDeps } from "../pricing/actions/local.ts";
import type { CacheDeps } from "../cache/providerCache.ts";
import type { findRecentResearch } from "../projectContext/service.ts";
import { peekCached } from "../research/cache.ts";
import { planFetch, REUSE_WINDOW_MINUTES } from "./fetches.ts";
import { listingsCacheInput, type ListingsInput } from "./listings.ts";
import { profileResearchKey, recentResearchWarning } from "./research.ts";
import { supabaseLocalStore, type LocalStore } from "./store.ts";

export type LocalQuoteSources = {
  findRecentResearch?: typeof findRecentResearch;
  store?: LocalStore;
  cacheDeps?: CacheDeps;
};

let overrides: LocalQuoteSources | null = null;

/** Tests inject fakes here; pass null to restore the production sources. */
export function setLocalQuoteSources(next: LocalQuoteSources | null): void {
  overrides = next;
}


type Ctx = { brandKey: string; admin: SupabaseClient | null; now: Date };

function hasSource(ctx: Ctx): boolean {
  return Boolean(ctx.admin || overrides?.store);
}

function storeFor(ctx: Ctx): LocalStore {
  return overrides?.store ?? supabaseLocalStore(ctx.admin as SupabaseClient);
}

export function profileQuoteDeps(
  ctx: Ctx,
  input: { identifier: { businessName?: string; cid?: string; placeId?: string } },
): LocalPricingDeps {
  return {
    hasRecentResearch: async () => {
      if (!ctx.admin && !overrides?.findRecentResearch) return false;
      const warning = await recentResearchWarning(
        ctx.admin as SupabaseClient,
        {
          brandKey: ctx.brandKey,
          kind: "local.business",
          researchKey: profileResearchKey({
            cid: input.identifier.cid,
            placeId: input.identifier.placeId,
            name: input.identifier.businessName,
          }),
        },
        overrides?.findRecentResearch ? { findRecentResearch: overrides.findRecentResearch } : undefined,
      );
      return warning !== null;
    },
  };
}

export function listingsQuoteDeps(ctx: Ctx, input: Omit<ListingsInput, "requestId" | "maxUsd">): LocalPricingDeps {
  return {
    isCacheHit: async () => {
      if (!ctx.admin && !overrides?.cacheDeps) return false;
      try {
        const peek = await peekCached(
          listingsCacheInput({ ...input, requestId: "" }),
          overrides?.cacheDeps ? { cacheDeps: overrides.cacheDeps } : undefined,
        );
        return peek !== null && peek.value.rows.length > 0;
      } catch {
        return false;
      }
    },
  };
}

/**
 * A fetch quotes as free only when the service will reuse it: the same exact reuse hash as
 * `startFetch` (kind, identifier, depth, sort and location) found through `find_local_reuse`
 * inside the 60-minute window. If the hash cannot be computed exactly (business missing, no
 * identifier, or no coordinate or location code without the workspace market), the quote is full price.
 */
export function fetchQuoteDeps(
  ctx: Ctx,
  input: { businessId: string; depth: number; sortBy?: string; includeOtherSources?: boolean },
  kind: "reviews" | "updates" | "questions",
): LocalPricingDeps {
  return {
    findReuse: async () => {
      if (!hasSource(ctx)) return null;
      try {
        const store = storeFor(ctx);
        const business = await store.getBusiness(ctx.brandKey, input.businessId);
        if (!business) return null;
        const plan = planFetch(business, { kind, ...input }, null);
        if (!plan || plan.hash === null) return null;
        const since = new Date(ctx.now.getTime() - REUSE_WINDOW_MINUTES * 60_000).toISOString();
        const reuseId = await store.findReuse(ctx.brandKey, "fetch", plan.hash, since);
        if (!reuseId) return null;
        const row = await store.getFetch(ctx.brandKey, reuseId);
        if (!row) return null;
        return { minutesAgo: Math.max(0, Math.floor((ctx.now.getTime() - Date.parse(row.created_at)) / 60_000)) };
      } catch {
        return null;
      }
    },
  };
}

/** Grids created today (UTC) for the workspace; the estimate blocks at 20. */
export function gridQuoteDeps(ctx: Ctx): LocalPricingDeps {
  return {
    checkGridLimitToday: async () => {
      if (!hasSource(ctx)) return 0;
      try {
        const d = ctx.now;
        const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
        return await storeFor(ctx).countGridsSince(ctx.brandKey, dayStart);
      } catch {
        return 0;
      }
    },
  };
}
