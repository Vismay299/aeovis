"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/useAhrefsDomainRatings.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
// Adaptations: projectId -> brandKey; the server-function call becomes a POST
// to our flagged /api/customer/backlinks/ahrefs-dr route via fetchJson;
// remeda chunk/unique replaced with local helpers (no new dependency);
// successful loads are mirrored into the ahrefsRatings query key and emit
// backlinks:ahrefs_dr via trackBacklinksEvent.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchJson } from "@/lib/query/fetchJson";
import { keys, stableStringify } from "@/lib/query/keys";
import { trackBacklinksEvent } from "./telemetry";

/** Map of domain (as held in table rows) → Ahrefs DR, or null when unknown. */
export type DomainRatings = Record<string, number | null>;

// The route caps each call at 100 domains, so the client chunks larger sets
// and calls sequentially.
const DOMAINS_PER_REQUEST = 100;

type AhrefsDrResponse = {
  ratings: Record<string, number | null>;
};

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function useAhrefsDomainRatings(brandKey: string) {
  const queryClient = useQueryClient();
  const [ratings, setRatings] = useState<DomainRatings | null>(null);
  const ratingsRef = useRef<DomainRatings | null>(null);
  const pendingDomainsRef = useRef(new Set<string>());
  const [activeLoadCount, setActiveLoadCount] = useState(0);

  useEffect(() => {
    ratingsRef.current = ratings;
  }, [ratings]);

  const loadRatings = useCallback(
    async (domains: string[]) => {
      const currentRatings = ratingsRef.current;
      const pendingDomains = pendingDomainsRef.current;
      const targets = [
        ...new Set(domains.filter(Boolean)),
      ].filter(
        (domain) =>
          !Object.hasOwn(currentRatings ?? {}, domain) &&
          !pendingDomains.has(domain),
      );
      if (targets.length === 0) return;

      for (const domain of targets) pendingDomains.add(domain);
      setActiveLoadCount((count) => count + 1);
      const fetched: DomainRatings = {};
      try {
        for (const batch of chunkArray(targets, DOMAINS_PER_REQUEST)) {
          const response = await fetchJson<AhrefsDrResponse>(
            "/api/customer/backlinks/ahrefs-dr",
            { method: "POST", body: { domains: batch } },
          );
          Object.assign(fetched, response.ratings ?? {});
        }
      } catch {
        // Opt-in convenience feature — surface partial results, don't crash.
        toast.error("Could not load Ahrefs DR.");
      } finally {
        if (Object.keys(fetched).length > 0) {
          const nextRatings = { ...ratingsRef.current, ...fetched };
          ratingsRef.current = nextRatings;
          setRatings(nextRatings);
          queryClient.setQueryData(
            keys.ahrefsRatings(brandKey, stableStringify({ domains: targets })),
            nextRatings,
          );
          trackBacklinksEvent("backlinks:ahrefs_dr", {
            count: Object.keys(fetched).length,
          });
        }
        for (const domain of targets) pendingDomains.delete(domain);
        setActiveLoadCount((count) => Math.max(0, count - 1));
      }
    },
    [brandKey, queryClient],
  );

  return { ratings, isLoading: activeLoadCount > 0, loadRatings };
}
