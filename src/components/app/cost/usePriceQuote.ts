// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/TrackingCostReview.tsx:35-84
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  keepPreviousData,
  queryOptions,
  useQuery,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { fetchJson } from "@/lib/query/fetchJson";
import { stableStringify } from "@/lib/query/keys";
import type { PriceQuote } from "@/shared/pricing";

export type PriceQuoteArgs = {
  brandKey: string;
  action: string;
  input: unknown;
};

export function priceQuoteQueryOptions(args: PriceQuoteArgs) {
  const { brandKey, action, input } = args;
  return queryOptions({
    queryKey: ["price", brandKey, action, stableStringify(input)] as const,
    queryFn: ({ signal }): Promise<PriceQuote> =>
      fetchJson<PriceQuote>("/api/customer/price/estimate", {
        method: "POST",
        body: { brand_key: brandKey, action, input },
        signal,
      }),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function prefetchPriceQuote(
  queryClient: QueryClient,
  args: PriceQuoteArgs,
): Promise<void> {
  return queryClient.prefetchQuery(priceQuoteQueryOptions(args));
}

export function usePriceQuote(
  args: PriceQuoteArgs,
  options?: { enabled?: boolean },
): UseQueryResult<PriceQuote, Error> {
  return useQuery({
    ...priceQuoteQueryOptions(args),
    enabled: options?.enabled ?? Boolean(args.brandKey && args.action),
    placeholderData: keepPreviousData,
  });
}
