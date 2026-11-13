"use client";

import { useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/query/fetchJson";

/** Starts Google's consent flow and leaves the page for the returned URL. */
export function useStartGa4Link(brandKey: string, returnTo: string) {
  return useMutation({
    mutationFn: () =>
      fetchJson<{ authorizationUrl: string }>("/api/customer/ga4/connect", {
        method: "POST",
        body: { brand_key: brandKey, returnTo },
      }),
    onSuccess: ({ authorizationUrl }) => {
      window.location.assign(authorizationUrl);
    },
  });
}
