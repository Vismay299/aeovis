export const FEATURES = {
  jobs_tick: { spend: [] as const },
  product_analytics: { spend: [] as const },
} as const;

export type FeatureName = keyof typeof FEATURES;
