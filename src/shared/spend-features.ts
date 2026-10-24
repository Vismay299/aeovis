export const SPEND_FEATURES = ["platform.selftest"] as const;

export type SpendFeature = (typeof SPEND_FEATURES)[number];

export function isSpendFeature(v: string): v is SpendFeature {
  return (SPEND_FEATURES as readonly string[]).includes(v);
}
