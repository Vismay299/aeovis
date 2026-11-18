// The names every skill and the F22 registry agree on. F22's registry test asserts
// set(registry) === set(TOOL_NAMES). F23 moves PLANNED_TOOL_NAMES into TOOL_NAMES.
export const TOOL_NAMES = [
  // F07
  "get_project_context", "update_project_context",
  // F08
  "list_questions", "add_questions",
  // F13
  "list_saved_keywords", "save_keywords", "research_keywords",
  // F14
  "get_domain_overview", "get_ranked_keywords",
  // F15
  "list_rank_trackers", "get_rank_tracker", "add_rank_tracking_keywords", "run_rank_check",
  // F16
  "get_backlinks_overview", "list_backlinks", "list_referring_domains", "get_backlink_history",
  // F17
  "search_local_businesses", "get_local_serp_results", "get_local_rank_grid", "get_business_profile",
  "get_business_reviews", "get_business_updates", "get_google_business_questions", "list_business_categories",
  // F18
  "run_site_audit", "get_site_audit_status", "get_site_audit_issues", "get_site_audit_pages", "list_site_audits",
  // F19
  "submit_indexnow_urls",
  // F20
  "get_google_analytics_organic_overview", "get_google_analytics_organic_landing_pages",
  "get_google_analytics_page_performance", "get_google_analytics_key_events",
  "get_google_analytics_traffic_acquisition", "get_google_analytics_ecommerce_performance",
  "get_google_analytics_site_search", "get_google_analytics_audience_breakdown",
  "get_google_analytics_measurement_health", "get_search_opportunities",
  // F22 (own tools, F22 §6.2.6)
  "get_measurement_status", "list_scans", "get_scan_report", "get_scan_answer", "get_scan_sources",
  "get_scan_status", "run_scan", "explore_question", "get_explore_run", "get_question_history",
  "get_question_answer", "research_questions", "generate_questions", "estimate_price",
  "get_serp_results", "find_serp_competitors", "get_search_console_performance",
  "map_site_pages", "read_pages", "check_ai_crawler_access", "start_content_draft", "list_content_items",
  // F23
  "list_reports", "get_report", "save_report", "list_report_templates",
] as const;

export const PLANNED_TOOL_NAMES = [] as const;

export const PAID_TOOL_NAMES = [
  "research_keywords", "get_domain_overview", "get_ranked_keywords", "add_rank_tracking_keywords", "run_rank_check",
  "get_backlinks_overview", "list_backlinks", "list_referring_domains", "search_local_businesses",
  "get_local_serp_results", "get_local_rank_grid", "get_business_profile", "get_business_reviews",
  "get_business_updates", "get_google_business_questions", "run_site_audit", "run_scan", "explore_question",
  "research_questions", "generate_questions", "get_serp_results", "find_serp_competitors", "start_content_draft",
] as const; // may need a price approval card for some inputs (F22 §6.2.4)

// effect "external" with a confirm card and no price (F22 §6.2.6 catalogue)
export const EXTERNAL_TOOL_NAMES = ["submit_indexnow_urls"] as const;

// Backticked snake_case tokens in skill bodies that are not tool names. Adding a term is a reviewed edit.
export const SKILL_TERMS: ReadonlySet<string> = new Set([
  "business_overview", "current_goal", "writing_preferences", "research_log", "key_pages", "custom_section",
  "geo_article", "linkedin_post", "striking_distance", "local_pack", "ai_overview", "featured_snippet",
  "exact_url", "search_volume", "keyword_difficulty", "only_gaps",
  // field names kept from the ported bodies (link-prospecting, local-seo)
  "contact_url", "place_id", "last_updated_time",
]);

export type ToolName = (typeof TOOL_NAMES)[number] | (typeof PLANNED_TOOL_NAMES)[number];

const DECLARED: ReadonlySet<string> = new Set<string>([...TOOL_NAMES, ...PLANNED_TOOL_NAMES]);

export function isDeclaredToolName(value: string): value is ToolName {
  return DECLARED.has(value);
}
