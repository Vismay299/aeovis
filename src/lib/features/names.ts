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
  // F03: gates the customer Usage page and its route. Reading costs spends nothing.
  usage_page: { spend: [] as const },
  // F24: shows Continue with Google on the sign-in pages. Sign-in spends nothing; not a client feature (no workspace yet).
  google_sign_in: { spend: [] as const },
  // F10: gates customer-managed scheduled scans and their routes/jobs.
  customer_scheduling: { spend: ["ai_visibility.scan"] as const },
  // F25: lifecycle email outbox, delivery, and transactional notifications.
  lifecycle_email: { spend: [] as const },
  // F20: Google Analytics 4 integration and search opportunities
  ga4: { spend: [] as const },
  // F19: IndexNow keys, submission, checks and history. Free (no spend).
  indexnow: { spend: [] as const },
  // F02: routes answer engines through DataForSEO
  dataforseo_engines: { spend: [] as const },
  // F08: gates question curation routes, approval, and workspace questions
  question_curation: { spend: [] as const },
  // F13: keyword research and SERP analysis
  keyword_research: { spend: ["keywords.research"] as const },
  // F13: AI topic grouping
  keyword_clustering: { spend: ["keywords.clustering"] as const },
  // F14: domain overview and competitor research
  domain_research: { spend: ["domain.research"] as const },
  // F17: Local SEO page, routes, sidebar item.
  local_seo: {
    spend: [
      "local.business",
      "local.reviews",
      "local.serp",
      "local.grid",
    ] as const,
  },
  // F08: gates AI question setup research and drafting Generate button
  question_setup: { spend: ["questions.setup", "questions.generate"] as const },
  // F08: gates question research from LLM mentions search
  prompt_research: { spend: ["questions.research"] as const },
  // F16: backlinks page, routes, sidebar item
  backlinks: { spend: ["backlinks.research"] as const },
  backlinks_ahrefs_dr: { spend: [] as const },
  backlink_snapshots: { spend: ["backlinks.snapshots"] as const },
  // F18: site audit API and its separately controlled paid options.
  site_audit: { spend: [] as const },
  site_audit_lighthouse: { spend: ["site_audit.lighthouse"] as const },
  site_audit_render: { spend: ["site_audit.render"] as const },
  site_audit_crawler_access: { spend: [] as const },
  // F06 phase 3: gates the server-side export route and the Scans "All answers"
  // export scope. Storage only; no paid provider calls.
  server_exports: { spend: [] as const },
  // F15: rank tracking page, routes, sidebar item, scheduled checks.
  rank_tracking: { spend: ["rank_tracking.check", "rank_tracking.suggestions", "rank_tracking.metrics"] as const },
  // F15: "Track as AI question" action and the AI-visibility column.
  rank_tracking_ai_questions: { spend: [] as const },
  // F27: onboarding wizard and setup checklist
  onboarding_wizard: { spend: [] as const },
} as const;

export type FeatureName = keyof typeof FEATURES;
