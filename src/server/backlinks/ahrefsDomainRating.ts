// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/serverFunctions/ahrefs.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import {
  cached as defaultCached,
  type CacheDeps,
} from "../cache/providerCache.ts";
import { AppError } from "../../shared/http/appError.ts";
import { normalizeDomainInput } from "../research/target.ts";

export const AHREFS_DR_ENDPOINT =
  "https://api.ahrefs.com/v3/public/domain-rating-free";
export const FETCH_BATCH_SIZE = 20;
export const MAX_DOMAINS_PER_CALL = 100;
export const FETCH_TIMEOUT_MS = 5000;

export const AHREFS_DR_CACHE = {
  namespace: "backlinks.ahrefs_dr",
  version: 1,
  ttlSeconds: 86400,
} as const;

const ahrefsProviderResponseSchema = z.object({
  domain_rating: z.object({
    domain_rating: z.number().min(0).max(100),
  }),
});

const ahrefsCachedRatingSchema = z.strictObject({
  dr: z.number().min(1).max(100).nullable(),
});

export type AhrefsDomainRatingDeps = {
  fetch?: typeof fetch;
  cached?: typeof defaultCached;
  cacheDeps?: CacheDeps;
  /** Per-lookup timeout; tests shorten it. Defaults to FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
};

export async function getAhrefsDomainRatings(
  domains: string[],
  deps?: AhrefsDomainRatingDeps,
): Promise<Record<string, number | null>> {
  if (domains.length > MAX_DOMAINS_PER_CALL) {
    throw new AppError(
      400,
      "invalid_request",
      "Too many domains: at most 100 per call.",
    );
  }
  const fetchFn = deps?.fetch ?? fetch;
  const cachedFn = deps?.cached ?? defaultCached;
  const result: Record<string, number | null> = {};

  // Several original inputs can collapse to one normalized domain (www/non-www,
  // protocol variants). Resolve each normalized domain once, then fan the value
  // back out to every original key the caller sent. Invalid inputs map to null
  // without a fetch.
  const originalsByDomain = new Map<string, string[]>();
  for (const original of domains) {
    let domain: string;
    try {
      domain = normalizeDomainInput(original, true);
    } catch {
      result[original] = null;
      continue;
    }
    const existing = originalsByDomain.get(domain);
    if (existing) existing.push(original);
    else originalsByDomain.set(domain, [original]);
  }

  const ratings = new Map<string, number | null>();
  const keys = [...originalsByDomain.keys()];
  for (let i = 0; i < keys.length; i += FETCH_BATCH_SIZE) {
    const batch = keys.slice(i, i + FETCH_BATCH_SIZE);
    const resolved = await Promise.all(
      batch.map(async (domain) => {
        // A single failure must not fail the whole call.
        try {
          return [
            domain,
            await resolveDomainRating(
              domain,
              fetchFn,
              cachedFn,
              deps?.cacheDeps,
              deps?.timeoutMs ?? FETCH_TIMEOUT_MS,
            ),
          ] as const;
        } catch {
          return [domain, null] as const;
        }
      }),
    );
    for (const [domain, dr] of resolved) ratings.set(domain, dr);
  }

  for (const [domain, originals] of originalsByDomain) {
    const dr = ratings.get(domain) ?? null;
    for (const original of originals) result[original] = dr;
  }

  return result;
}

async function resolveDomainRating(
  domain: string,
  fetchFn: typeof fetch,
  cachedFn: typeof defaultCached,
  cacheDeps: CacheDeps | undefined,
  timeoutMs: number,
): Promise<number | null> {
  const res = await cachedFn(
    {
      namespace: AHREFS_DR_CACHE.namespace,
      version: AHREFS_DR_CACHE.version,
      keyParts: [domain],
      ttlSeconds: AHREFS_DR_CACHE.ttlSeconds,
      schema: ahrefsCachedRatingSchema,
      scope: "global",
    },
    () => fetchDomainRating(domain, fetchFn, timeoutMs),
    cacheDeps,
  );
  return res.value.dr;
}

async function fetchDomainRating(
  domain: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ dr: number | null }> {
  const response = await fetchFn(
    `${AHREFS_DR_ENDPOINT}?target=${encodeURIComponent(domain)}`,
    {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(`Ahrefs DR lookup failed with status ${response.status}`);
  }

  const parsed = ahrefsProviderResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Ahrefs DR lookup returned an unexpected response");
  }

  // The upstream lookup returns 200 with DR 0 for domains it has no rating
  // for, so treat 0 as "no rating" — the table renders it as "—".
  const dr = parsed.data.domain_rating.domain_rating;
  return { dr: dr > 0 ? dr : null };
}
