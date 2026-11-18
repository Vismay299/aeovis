// Shared by the customer report routes (F23 §6.5), so each route states its own
// business once instead of repeating the workspace gate, the hidden-when-off rule
// and the skill title lookup. Own code.

import { AppError } from "../../shared/http/appError.ts";
import { SKILL_MANIFEST } from "../../assistant/skills/manifest.generated.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
  type Workspace,
} from "../workspace/requireWorkspace.ts";

export const REPORTS_FEATURE_OFF = "This page is not available for your workspace yet.";

export type ReportsRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
};

/**
 * `requireWorkspace`, then the `reports` flag: with the flag off every report
 * route is hidden with a 404 (never a 403), after authentication.
 * `requireWorkspace` itself reads `brand_key` from the query when `brandKey` is
 * not given, so callers pass only the body's value.
 */
export async function requireReportsWorkspace(
  request: Request,
  brandKey: string | undefined,
  deps?: ReportsRouteDeps,
): Promise<Workspace> {
  const workspace = await requireWorkspace(request, { brandKey }, deps);
  if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("reports", workspace.brandKey))) {
    throw new AppError(404, "feature_unavailable", REPORTS_FEATURE_OFF);
  }
  return workspace;
}

/** The display title of a skill, or null for none or an unknown name. */
export function skillTitleFor(skill: string | null): string | null {
  if (!skill) return null;
  return SKILL_MANIFEST.find((entry) => entry.name === skill)?.title ?? null;
}
