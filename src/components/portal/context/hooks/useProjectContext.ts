"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/shared.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { keys } from "@/shared/query/keys";
import { fetchJson } from "@/shared/query/fetchJson";
import type {
  ProjectContext,
  ProjectContextUpdate,
} from "@/shared/project-context";

export function useProjectContext(brandKey: string) {
  return useQuery({
    queryKey: keys.projectContext(brandKey),
    queryFn: () =>
      fetchJson<ProjectContext>(
        `/api/customer/context?brand_key=${encodeURIComponent(brandKey)}`,
      ),
    enabled: Boolean(brandKey),
    staleTime: 0,
  });
}

/**
 * Every edit on this page is a patch op against the same endpoint, so all of
 * them share one mutation. The server returns the context as it stands after
 * the patch, which becomes the new cache entry — no refetch.
 */
export function useContextUpdate(brandKey: string) {
  const queryClient = useQueryClient();
  const queryKey = keys.projectContext(brandKey);

  return useMutation({
    mutationFn: (updates: ProjectContextUpdate[]) =>
      fetchJson<ProjectContext>("/api/customer/context", {
        method: "PATCH",
        body: { brand_key: brandKey, updates },
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
    },
    onSuccess: (context) => {
      queryClient.setQueryData(queryKey, context);
      toast.success("Context updated");
    },
    // Refetch only after a failure. Not onError: a useMutation onError opts the
    // mutation out of the shared error toast (src/shared/query/queryClient.ts).
    onSettled: async (_data, error) => {
      if (error) await queryClient.invalidateQueries({ queryKey });
    },
  });
}
