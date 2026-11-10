export const SPEND_FEATURES = [
  "platform.selftest",
  "providers.dataforseo.selftest",
] as const;

export type SpendFeature = (typeof SPEND_FEATURES)[number];

export function isSpendFeature(v: string): v is SpendFeature {
  return (SPEND_FEATURES as readonly string[]).includes(v);
}

/**
 * Customer-facing labels for the ledger's `feature` column.
 *
 * The ledger's `feature` is free text (F01's table carries no value CHECK), so
 * a row may name a feature this build has never heard of. Every later spec adds
 * its label line here in the same PR that adds its `SpendFeature`.
 */
export const SPEND_FEATURE_LABELS: Record<string, string> = {
  "ai_visibility.scan": "AI visibility scans",
  "platform.selftest": "Platform check",
  "providers.dataforseo.selftest": "DataForSEO self-test",
};

/** The label for a ledger feature; an unknown key is "Other", never an empty string. */
export function spendFeatureLabel(feature: string): string {
  return SPEND_FEATURE_LABELS[feature] ?? "Other";
}
