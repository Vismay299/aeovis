export const FEATURES = {
  jobs_tick: { spend: [] as const },
} as const;

export type FeatureName = keyof typeof FEATURES;
