/**
 * Client-visible feature flags (F04 owns this module).
 *
 * `CLIENT_FEATURES` is the list of flags the BROWSER may read: a sidebar item
 * with a `flag` is hidden while that flag is off, and optional UI asks the
 * server whether it may show. Each spec appends its own names here as its UI
 * ships.
 *
 * `readClientFeatures` is the server-side read of that list for ONE
 * workspace: it evaluates every name and returns the on/off map the customer
 * route hands to the browser. A name whose evaluation rejects counts as
 * false — a flag that cannot be read is never a reason to show a feature.
 */
import { isFeatureEnabled } from "./flags.ts";
import type { FeatureName } from "./names.ts";

/**
 * Flags whose on/off state the browser may read (sidebar items, optional UI).
 * Each spec appends its own names.
 */
export const CLIENT_FEATURES: readonly FeatureName[] = [
  "product_analytics",
  "lifecycle_email",
  "ga4",
  "indexnow",
  "price_review",
  "project_memory",
  "keyword_research",
  "keyword_clustering",
  "domain_research",
  "local_seo",
  "backlinks",
  "backlinks_ahrefs_dr",
  "backlink_snapshots",
  "customer_scheduling",
  "site_audit",
  "site_audit_lighthouse",
  "site_audit_render",
  "site_audit_crawler_access",
  "server_exports",
  "usage_page",
  "question_curation",
  "question_setup",
  "prompt_research",
];

export type ClientFeatureName = FeatureName;

/**
 * The seams a caller (and the route test) may replace: WHICH names to
 * evaluate, and how to evaluate each one. Both default to the shipped
 * behaviour — the module's own list and F01's `isFeatureEnabled`.
 */
export type ReadClientFeaturesDeps = {
  isEnabled?: (name: FeatureName, brandKey: string) => Promise<boolean>;
  names?: readonly FeatureName[];
};

export async function readClientFeatures(
  brandKey: string,
  deps?: ReadClientFeaturesDeps
): Promise<Record<string, boolean>> {
  const names = deps?.names ?? CLIENT_FEATURES;
  const evaluate =
    deps?.isEnabled ?? ((name: FeatureName, key: string) => isFeatureEnabled(name, key));

  // Every name is evaluated in parallel; a rejection is that name's answer,
  // never the whole read's failure.
  const entries = await Promise.all(
    names.map(async (name): Promise<[string, boolean]> => {
      try {
        return [name, await evaluate(name, brandKey)];
      } catch {
        return [name, false];
      }
    })
  );

  return Object.fromEntries(entries);
}
