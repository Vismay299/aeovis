"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/useBacklinksPageData.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { resolveBacklinksScope } from "./useBacklinksPageData";
import { useCallback, useMemo } from "react";
import { useSearchTabNavigation } from "@/components/app/search-tabs/useSearchTabNavigation";
import { researchScopeSchema, type ResearchScope } from "@/shared/researchScope";

export type BacklinksTabInput = {
  target: string;
  scope: ResearchScope;
};

export function useBacklinksSearchTabs({
  brandKey,
  target,
  scope,
  onNavigate,
}: {
  brandKey: string;
  target?: string;
  scope?: ResearchScope;
  onNavigate: (input: BacklinksTabInput | null) => void;
}) {
  const parseInput = useCallback((raw: unknown): BacklinksTabInput | null => {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.target !== "string" || !r.target) return null;
    const parsedScope = researchScopeSchema.safeParse(r.scope);
    return {
      target: r.target,
      scope: parsedScope.success ? parsedScope.data : "subdomains",
    };
  }, []);

  const urlInput: BacklinksTabInput | null = useMemo(
    () => (target ? { target, scope: resolveBacklinksScope(target, scope) } : null),
    [target, scope],
  );

  return useSearchTabNavigation<BacklinksTabInput>({
    feature: "backlinks",
    brandKey,
    parseInput,
    urlInput,
    getLabel: (input) => input.target,
    navigateToInput: onNavigate,
  });
}
