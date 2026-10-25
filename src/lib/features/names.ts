export const FEATURES = {
  jobs_tick: { spend: [] as const },
  product_analytics: { spend: [] as const },
  // F21: hides the assistant's skill catalogue without touching tools. Skills spend nothing.
  assistant_skills: { spend: [] as const },
} as const;

export type FeatureName = keyof typeof FEATURES;
