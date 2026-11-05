export const FEATURES = {
  jobs_tick: { spend: [] as const },
  product_analytics: { spend: [] as const },
  // F21: hides the assistant's skill catalogue without touching tools. Skills spend nothing.
  assistant_skills: { spend: [] as const },
  // F07: gates the context page, its two routes and the assistant tools. Memory spends nothing.
  project_memory: { spend: [] as const },
  // F07: lets Content Studio read project memory. The digest is free.
  project_memory_content: { spend: [] as const },
  // F09: shows the cost review dialog before running a paid scan
  price_review: { spend: [] as const },
} as const;

export type FeatureName = keyof typeof FEATURES;
