// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/onboarding/useOnboardingRedirect.ts:12-61
//   src/routes/_app/route.tsx:34-39
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { normalizeAuthRedirect } from "../../../shared/auth-redirect.ts";

export type OnboardingRedirectInput = {
  flagKnown: boolean;
  memberships: Array<{ brandKey?: string }>;
  row: { completed_at?: string | null } | null;
  state: { enabled: boolean; needsOnboarding: boolean } | null;
  pathname: string;
  search: string;
};

/** Pure route decision so existing workspaces can never be redirected by a missing row. */
export function decideOnboardingRedirect({
  flagKnown,
  memberships,
  row,
  state,
  pathname,
  search,
}: OnboardingRedirectInput): string | null {
  if (!flagKnown || !state?.enabled || !state.needsOnboarding) return null;
  if (row?.completed_at) return null;
  if (memberships.length > 0 && !row) return null;

  const requested = normalizeAuthRedirect(`${pathname}${search}`, "");
  if (!requested || requested === "/portal") return "/onboarding";
  return `/onboarding?redirect=${encodeURIComponent(requested)}`;
}
