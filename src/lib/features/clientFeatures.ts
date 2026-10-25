/**
 * Client-visible feature flags (F04 owns the full module; F26 seeds product_analytics).
 * Expanded by later features when their UI ships.
 */
export const CLIENT_FEATURES = ["product_analytics"] as const;

export type ClientFeatureName = (typeof CLIENT_FEATURES)[number];

export function readClientFeatures(features: Record<string, boolean> | null | undefined): Record<ClientFeatureName, boolean> {
  const out = {} as Record<ClientFeatureName, boolean>;
  for (const name of CLIENT_FEATURES) {
    out[name] = Boolean(features?.[name]);
  }
  return out;
}
