// F26 typed product-analytics event registry. Every product event lives here.
import { z } from "zod";
import { code, codes, count, durationMs, flag, oneOf, usd } from "./props.ts";

export type EventSpec = {
  side: "client" | "server";
  owner: `F${number}` | "existing";
  consent: "required" | "anonymous";
  props: z.ZodObject<z.ZodRawShape>;
};

export const EVENTS = {
  "usage:page_viewed": {
    side: "client",
    owner: "F03",
    consent: "required",
    props: z.strictObject({ range: oneOf(["7d", "30d", "90d"]) }),
  },
  "usage:range_changed": {
    side: "client",
    owner: "F03",
    consent: "required",
    props: z.strictObject({ from: oneOf(["7d", "30d", "90d"]), to: oneOf(["7d", "30d", "90d"]) }),
  },
  "scan_report:cost_expanded": {
    side: "client",
    owner: "F03",
    consent: "required",
    props: z.strictObject({}),
  },
  "data:export": {
    side: "client",
    owner: "F06",
    consent: "required",
    props: z.strictObject({ source_feature: code, format: oneOf(["csv", "excel", "json", "copy-json", "sheets"]), result_count: count, scope: oneOf(["all", "selection"]) }),
  },
  "data:export_sheets": {
    side: "client",
    owner: "F06",
    consent: "required",
    props: z.strictObject({ source_feature: code, result_count: count }),
  },
  "data:export_server": {
    side: "client",
    owner: "F06",
    consent: "required",
    props: z.strictObject({ kind: code, format: code, row_count: count }),
  },
  "project_context:viewed": {
    side: "client",
    owner: "F07",
    consent: "required",
    props: z.strictObject({}),
  },
  "project_context:updated": {
    side: "server",
    owner: "F07",
    consent: "required",
    props: z.strictObject({ ops: count, kinds: codes }),
  },
  "questions:setup_started": {
    side: "server",
    owner: "F08",
    consent: "required",
    props: z.strictObject({}),
  },
  "questions:setup_saved": {
    side: "server",
    owner: "F08",
    consent: "required",
    props: z.strictObject({ questions: count, competitors: count, approved: flag }),
  },
  "questions:approved": {
    side: "server",
    owner: "F08",
    consent: "required",
    props: z.strictObject({ version: count, count }),
  },
  "questions:added": {
    side: "server",
    owner: "F08",
    consent: "required",
    props: z.strictObject({ origin: oneOf(["ai_setup", "ai_generate", "prompt_research", "promptgen", "manual", "import"]), count }),
  },
  "questions:generated": {
    side: "server",
    owner: "F08",
    consent: "required",
    props: z.strictObject({ count }),
  },
  "questions:researched": {
    side: "server",
    owner: "F08",
    consent: "required",
    props: z.strictObject({ results: count, cached: flag }),
  },
  "price:quote_shown": {
    side: "client",
    owner: "F09",
    consent: "required",
    props: z.strictObject({ action: code, total_usd: usd, blocked_code: code.nullable() }),
  },
  "price:approved": {
    side: "client",
    owner: "F09",
    consent: "required",
    props: z.strictObject({ action: code, approved_usd: usd, source: oneOf(["dialog", "implicit", "schedule"]) }),
  },
  "price:changed": {
    side: "client",
    owner: "F09",
    consent: "required",
    props: z.strictObject({ action: code, old_usd: usd, new_usd: usd }),
  },
  "schedule:enabled": {
    side: "server",
    owner: "F10",
    consent: "required",
    props: z.strictObject({ interval: oneOf(["daily", "weekly", "monthly"]), approved_usd: usd }),
  },
  "schedule:paused": {
    side: "server",
    owner: "F10",
    consent: "required",
    props: z.strictObject({}),
  },
  "schedule:changed": {
    side: "server",
    owner: "F10",
    consent: "required",
    props: z.strictObject({ interval: oneOf(["daily", "weekly", "monthly"]) }),
  },
  "schedule:skipped": {
    side: "server",
    owner: "F10",
    consent: "required",
    props: z.strictObject({ reason: code }),
  },
  "prompt_explorer:run_started": {
    side: "server",
    owner: "F11",
    consent: "required",
    props: z.strictObject({ models: count, reused: flag, web_search: flag, has_country: flag }),
  },
  "prompt_explorer:run_finished": {
    side: "server",
    owner: "F11",
    consent: "required",
    props: z.strictObject({ status: code, answered: count, failed: count, reused: flag }),
  },
  "prompt_explorer:question_tracked": {
    side: "client",
    owner: "F11",
    consent: "required",
    props: z.strictObject({}),
  },
  "question_history:viewed": {
    side: "client",
    owner: "F12",
    consent: "required",
    props: z.strictObject({ executions: count, range: code }),
  },
  "question_history:answer_opened": {
    side: "client",
    owner: "F12",
    consent: "required",
    props: z.strictObject({ engine: oneOf(["chatgpt", "gemini", "perplexity", "aio"]), source: code }),
  },
  "keyword_research:search_complete": {
    side: "client",
    owner: "F13",
    consent: "required",
    props: z.strictObject({ location_code: count, search_mode: code, clickstream: flag, local: flag, result_count: count, cached: flag }),
  },
  "keyword_research:serp_open": {
    side: "client",
    owner: "F13",
    consent: "required",
    props: z.strictObject({}),
  },
  "keyword:save": {
    side: "client",
    owner: "F13",
    consent: "required",
    props: z.strictObject({ source_feature: oneOf(["keyword_research", "domain_overview", "rank_tracking"]), keyword_count: count }),
  },
  "saved_keywords:bulk_remove": {
    side: "client",
    owner: "F13",
    consent: "required",
    props: z.strictObject({ count }),
  },
  "saved_keywords:bulk_tag": {
    side: "client",
    owner: "F13",
    consent: "required",
    props: z.strictObject({ count }),
  },
  "saved_keywords:refresh_start": {
    side: "client",
    owner: "F13",
    consent: "required",
    props: z.strictObject({ stale: count }),
  },
  "keywords:cluster_apply": {
    side: "client",
    owner: "F13",
    consent: "required",
    props: z.strictObject({ topics: count, keywords: count }),
  },
  "keywords:track_question": {
    side: "client",
    owner: "F13",
    consent: "required",
    props: z.strictObject({ created: count }),
  },
  "domain_overview:lookup": {
    side: "client",
    owner: "F14",
    consent: "required",
    props: z.strictObject({ scope: code, cached: flag, has_data: flag }),
  },
  "domain_overview:tab": {
    side: "client",
    owner: "F14",
    consent: "required",
    props: z.strictObject({ tab: code }),
  },
  "domain_overview:competitors": {
    side: "client",
    owner: "F14",
    consent: "required",
    props: z.strictObject({ keyword_count: count, result_count: count }),
  },
  "domain_overview:add_competitor": {
    side: "client",
    owner: "F14",
    consent: "required",
    props: z.strictObject({}),
  },
  "rank_tracking:config_create": {
    side: "client",
    owner: "F15",
    consent: "required",
    props: z.strictObject({ devices: code, schedule: code, local: flag }),
  },
  "rank_tracking:keywords_add": {
    side: "client",
    owner: "F15",
    consent: "required",
    props: z.strictObject({ count, source: code }),
  },
  "rank_tracking:check_trigger": {
    side: "client",
    owner: "F15",
    consent: "required",
    props: z.strictObject({ keywords: count, subset: flag }),
  },
  "rank_tracking:check_complete": {
    side: "server",
    owner: "F15",
    consent: "anonymous",
    props: z.strictObject({ status: code, trigger: code, keywords_checked: count }),
  },
  "rank_tracking:pin": {
    side: "client",
    owner: "F15",
    consent: "required",
    props: z.strictObject({ pinned: flag }),
  },
  "rank_tracking:metrics_refresh": {
    side: "client",
    owner: "F15",
    consent: "required",
    props: z.strictObject({ bought: count, from_cache: count }),
  },
  "rank_tracking:suggestions_open": {
    side: "client",
    owner: "F15",
    consent: "required",
    props: z.strictObject({ cached: flag, count }),
  },
  "rank_tracking:export_csv": {
    side: "client",
    owner: "F15",
    consent: "required",
    props: z.strictObject({ scope: code }),
  },
  "rank_tracking:track_question": {
    side: "client",
    owner: "F15",
    consent: "required",
    props: z.strictObject({ created: count }),
  },
  "backlinks:lookup": {
    side: "client",
    owner: "F16",
    consent: "required",
    props: z.strictObject({ scope: code, cached: flag }),
  },
  "backlinks:tab": {
    side: "client",
    owner: "F16",
    consent: "required",
    props: z.strictObject({ tab: code }),
  },
  "backlinks:expand_domain": {
    side: "client",
    owner: "F16",
    consent: "required",
    props: z.strictObject({}),
  },
  "backlinks:ahrefs_dr": {
    side: "client",
    owner: "F16",
    consent: "required",
    props: z.strictObject({ count }),
  },
  "backlinks:track_history": {
    side: "client",
    owner: "F16",
    consent: "required",
    props: z.strictObject({ interval: code }),
  },
  "local:business_saved": {
    side: "client",
    owner: "F17",
    consent: "required",
    props: z.strictObject({ role: code }),
  },
  "local:profile_lookup": {
    side: "client",
    owner: "F17",
    consent: "required",
    props: z.strictObject({ found: flag }),
  },
  "local:listings_search": {
    side: "client",
    owner: "F17",
    consent: "required",
    props: z.strictObject({ count, cached: flag }),
  },
  "local:reviews_collect": {
    side: "client",
    owner: "F17",
    consent: "required",
    props: z.strictObject({ depth: count, other_sources: flag, reused: flag }),
  },
  "local:updates_collect": {
    side: "client",
    owner: "F17",
    consent: "required",
    props: z.strictObject({ reused: flag }),
  },
  "local:questions_collect": {
    side: "client",
    owner: "F17",
    consent: "required",
    props: z.strictObject({ reused: flag }),
  },
  "local:serp_search": {
    side: "client",
    owner: "F17",
    consent: "required",
    props: z.strictObject({ type: code, cached: flag, own_ranked: flag }),
  },
  "local:grid_run": {
    side: "client",
    owner: "F17",
    consent: "required",
    props: z.strictObject({ size: count, reused: flag, points_found: count }),
  },
  "site_audit:launch_open": {
    side: "client",
    owner: "F18",
    consent: "required",
    props: z.strictObject({}),
  },
  "site_audit:large_confirm": {
    side: "client",
    owner: "F18",
    consent: "required",
    props: z.strictObject({ pages: count }),
  },
  "site_audit:cancel": {
    side: "client",
    owner: "F18",
    consent: "required",
    props: z.strictObject({}),
  },
  "site_audit:delete": {
    side: "client",
    owner: "F18",
    consent: "required",
    props: z.strictObject({}),
  },
  "site_audit:lighthouse_open": {
    side: "client",
    owner: "F18",
    consent: "required",
    props: z.strictObject({ strategy: code }),
  },
  "site_audit:compare_open": {
    side: "client",
    owner: "F18",
    consent: "required",
    props: z.strictObject({}),
  },
  "site_audit:view_change": {
    side: "client",
    owner: "F18",
    consent: "required",
    props: z.strictObject({ view: code }),
  },
  "site_audit:start": {
    side: "server",
    owner: "F18",
    consent: "required",
    props: z.strictObject({ max_pages: count, lighthouse: flag, render_js: flag, trigger: oneOf(["manual", "baseline", "tool"]) }),
  },
  "site_audit:complete": {
    side: "server",
    owner: "F18",
    consent: "anonymous",
    props: z.strictObject({ status: code, pages_crawled: count, pages_total: count, crawl_completed: flag, pages_blocked: count, pages_rate_limited: count, pages_abandoned: count, lighthouse: flag, render_js: flag, error_code: code.nullable(), failed_phase: code.nullable() }),
  },
  "indexnow:setup": {
    side: "client",
    owner: "F19",
    consent: "required",
    props: z.strictObject({ created: flag }),
  },
  "indexnow:check": {
    side: "client",
    owner: "F19",
    consent: "required",
    props: z.strictObject({ hosts: count, found: count, cached: flag }),
  },
  "indexnow:submit": {
    side: "client",
    owner: "F19",
    consent: "required",
    props: z.strictObject({ source: code, url_count: count, hosts: count, submitted_hosts: count, skipped: count }),
  },
  "indexnow:offer_shown": {
    side: "client",
    owner: "F19",
    consent: "required",
    props: z.strictObject({ state: code }),
  },
  "indexnow:offer_dismissed": {
    side: "client",
    owner: "F19",
    consent: "required",
    props: z.strictObject({}),
  },
  "ga4:link_start": {
    side: "client",
    owner: "F20",
    consent: "required",
    props: z.strictObject({ return_path: oneOf(["/portal/settings/integrations", "/portal/analytics", "/onboarding"]) }),
  },
  "ga4:property_select": {
    side: "client",
    owner: "F20",
    consent: "required",
    props: z.strictObject({}),
  },
  "ga4:disconnect": {
    side: "client",
    owner: "F20",
    consent: "required",
    props: z.strictObject({}),
  },
  "ga4:account_remove": {
    side: "client",
    owner: "F20",
    consent: "required",
    props: z.strictObject({ workspaces: count }),
  },
  "ga4:tab_view": {
    side: "client",
    owner: "F20",
    consent: "required",
    props: z.strictObject({ tab: code }),
  },
  "ga4:range_change": {
    side: "client",
    owner: "F20",
    consent: "required",
    props: z.strictObject({ range: code }),
  },
  "ga4:link_complete": {
    side: "server",
    owner: "F20",
    consent: "required",
    props: z.strictObject({ outcome: code }),
  },
  "ga4:report_view": {
    side: "server",
    owner: "F20",
    consent: "required",
    props: z.strictObject({ kind: code, cached: flag, limited: flag }),
  },
  "ga4:opportunities_view": {
    side: "server",
    owner: "F20",
    consent: "required",
    props: z.strictObject({ rows: count, matched: count, engagement_fallback: flag, cached: flag }),
  },
  "assistant:session_create": {
    side: "client",
    owner: "F22",
    consent: "required",
    props: z.strictObject({}),
  },
  "assistant:session_archive": {
    side: "client",
    owner: "F22",
    consent: "required",
    props: z.strictObject({}),
  },
  "assistant:turn": {
    side: "server",
    owner: "F22",
    consent: "required",
    props: z.strictObject({ status: code, stop_reason: code.nullable(), steps: count, tool_calls: count, cost_usd: usd.nullable(), cost_known: flag, model: code, compacted: flag, error_code: code.nullable() }),
  },
  "assistant:tool_call": {
    side: "server",
    owner: "F22",
    consent: "required",
    props: z.strictObject({ tool: code, effect: code, success: flag, error_code: code.nullable(), duration_ms: durationMs, awaiting_approval: flag }),
  },
  "assistant:approval": {
    side: "server",
    owner: "F22",
    consent: "required",
    props: z.strictObject({ tool: code, kind: code, decision: code, quoted_usd: usd, approved_max_usd: usd.nullable(), outcome: code, error_code: code.nullable() }),
  },
  "assistant:skill_activate": {
    side: "server",
    owner: "F22",
    consent: "required",
    props: z.strictObject({ skill: code, version: code }),
  },
  "assistant:message_send": {
    side: "client",
    owner: "F22",
    consent: "required",
    props: z.strictObject({ source: code, chars: count }),
  },
  "assistant:rewind": {
    side: "client",
    owner: "F22",
    consent: "required",
    props: z.strictObject({ kind: oneOf(["undo", "edit", "retry"]) }),
  },
  "assistant:stop": {
    side: "client",
    owner: "F22",
    consent: "required",
    props: z.strictObject({}),
  },
  "assistant:client_error": {
    side: "client",
    owner: "F22",
    consent: "required",
    props: z.strictObject({ kind: oneOf(["turn", "network", "resume"]) }),
  },
  "tool:call": {
    side: "server",
    owner: "F22",
    consent: "anonymous",
    props: z.strictObject({ tool: code, source: oneOf(["assistant", "approval", "mcp"]), success: flag, error_code: code.nullable(), duration_ms: durationMs, output_invalid: flag, truncated: flag }),
  },
  "report:saved": {
    side: "server",
    owner: "F23",
    consent: "required",
    props: z.strictObject({ skill: code, used_template: flag, size_bytes: count, is_update: flag, sanitized_changed: flag, source: oneOf(["assistant"]) }),
  },
  "report:opened": {
    side: "client",
    owner: "F23",
    consent: "required",
    props: z.strictObject({ skill: code }),
  },
  "report:exported_pdf": {
    side: "client",
    owner: "F23",
    consent: "required",
    props: z.strictObject({}),
  },
  "report:shared": {
    side: "server",
    owner: "F23",
    consent: "required",
    props: z.strictObject({ skill: code }),
  },
  "report:unshared": {
    side: "server",
    owner: "F23",
    consent: "required",
    props: z.strictObject({ skill: code }),
  },
  "report:deleted": {
    side: "client",
    owner: "F23",
    consent: "required",
    props: z.strictObject({}),
  },
  "report:public_view": {
    side: "server",
    owner: "F23",
    consent: "anonymous",
    props: z.strictObject({ from_browser: flag }),
  },
  "report_template:saved": {
    side: "client",
    owner: "F23",
    consent: "required",
    props: z.strictObject({ is_update: flag }),
  },
  "report_template:deleted": {
    side: "client",
    owner: "F23",
    consent: "required",
    props: z.strictObject({}),
  },
  "report:generate_start": {
    side: "server",
    owner: "F23",
    consent: "required",
    props: z.strictObject({}),
  },
  "auth:sign_in_submit": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({ method: oneOf(["email"]) }),
  },
  "auth:sign_in_success": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({ method: oneOf(["email"]) }),
  },
  "auth:sign_in_block_unverified": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({}),
  },
  "auth:sign_up_submit": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({}),
  },
  "auth:sign_up_success": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({ needs_verification: flag }),
  },
  "auth:google_start": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({ intent: oneOf(["sign_in", "sign_up"]) }),
  },
  "auth:signup_blocked": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({ reason: oneOf(["disposable_email", "captcha"]) }),
  },
  "auth:verification_resend": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({}),
  },
  "auth:verification_issue": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({ issue_type: oneOf(["link_expired", "unknown"]) }),
  },
  "auth:verification_success": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({}),
  },
  "auth:password_reset_requested": {
    side: "client",
    owner: "F24",
    consent: "required",
    props: z.strictObject({}),
  },
  "auth:sign_up_completed": {
    side: "server",
    owner: "F24",
    consent: "anonymous",
    props: z.strictObject({ method: oneOf(["email", "google"]), from_free_scan: flag, from_domain: flag }),
  },
  "email:sent": {
    side: "server",
    owner: "F25",
    consent: "anonymous",
    props: z.strictObject({ template: code, kind: oneOf(["transactional", "event", "contact"]), duplicate: flag }),
  },
  "email:skipped": {
    side: "server",
    owner: "F25",
    consent: "anonymous",
    props: z.strictObject({ template: code, reason: code }),
  },
  "email:failed": {
    side: "server",
    owner: "F25",
    consent: "anonymous",
    props: z.strictObject({ template: code, error_code: code }),
  },
  "email:unsubscribed": {
    side: "server",
    owner: "F25",
    consent: "required",
    props: z.strictObject({ category: oneOf(["scan_results", "schedule_alerts", "spend_alerts", "product_updates"]) }),
  },
  "email:preferences_changed": {
    side: "server",
    owner: "F25",
    consent: "required",
    props: z.strictObject({ product_updates: flag, scan_results: flag, schedule_alerts: flag, spend_alerts: flag, source: oneOf(["onboarding", "settings"]) }),
  },
  "privacy:analytics_enabled": {
    side: "client",
    owner: "F26",
    consent: "required",
    props: z.strictObject({ source: oneOf(["onboarding", "settings", "banner"]) }),
  },
  "onboarding:step_viewed": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({ step: count, step_name: oneOf(["website", "search_console", "analytics", "preferences", "first_scan"]) }),
  },
  "onboarding:step_skipped": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({ step: count, step_name: oneOf(["website", "search_console", "analytics", "preferences", "first_scan"]) }),
  },
  "onboarding:website_saved": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({ created_workspace: flag, country: code, research: oneOf(["started", "skipped", "unavailable"]) }),
  },
  "onboarding:website_save_failed": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({ error_code: code }),
  },
  "onboarding:gsc_connect_clicked": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({}),
  },
  "onboarding:gsc_property_selected": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({}),
  },
  "onboarding:ga4_connect_clicked": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({}),
  },
  "onboarding:preferences_saved": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({ product_updates: flag }),
  },
  "onboarding:first_scan_started": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({}),
  },
  "onboarding:audit_started": {
    side: "server",
    owner: "F27",
    consent: "required",
    props: z.strictObject({ started: flag, reason: code.nullable() }),
  },
  "onboarding:free_scan_imported": {
    side: "server",
    owner: "F27",
    consent: "required",
    props: z.strictObject({ questions: count }),
  },
  "onboarding:completed": {
    side: "server",
    owner: "F27",
    consent: "anonymous",
    props: z.strictObject({ via: oneOf(["wizard", "first_scan"]), steps_done: count, steps_skipped: count }),
  },
  "dashboard:setup_step_click": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({ step: code }),
  },
  "dashboard:setup_step_defer": {
    side: "client",
    owner: "F27",
    consent: "required",
    props: z.strictObject({ step: code, dismissed: flag }),
  },
  "scan:start_clicked": {
    side: "client",
    owner: "existing",
    consent: "required",
    props: z.strictObject({}),
  },
  "scan:started": {
    side: "server",
    owner: "existing",
    consent: "required",
    props: z.strictObject({ approved_usd: usd.nullable() }),
  },
  "content:draft_requested": {
    side: "client",
    owner: "existing",
    consent: "required",
    props: z.strictObject({}),
  },
  "content:review_submitted": {
    side: "client",
    owner: "existing",
    consent: "required",
    props: z.strictObject({ verdict: code }),
  },
  "team:invite_sent": {
    side: "client",
    owner: "existing",
    consent: "required",
    props: z.strictObject({ role: oneOf(["owner", "member"]), user_exists: flag }),
  },
  "gsc:connect_start": {
    side: "client",
    owner: "existing",
    consent: "required",
    props: z.strictObject({}),
  },
  "gsc:property_select": {
    side: "client",
    owner: "existing",
    consent: "required",
    props: z.strictObject({}),
  },
  "gsc:disconnect": {
    side: "client",
    owner: "existing",
    consent: "required",
    props: z.strictObject({}),
  },
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof EVENTS;
export type ClientEventName = {
  [K in EventName]: (typeof EVENTS)[K]["side"] extends "client" ? K : never;
}[EventName];
export type ServerEventName = Exclude<EventName, ClientEventName>;
export type EventProps<N extends EventName> = z.infer<(typeof EVENTS)[N]["props"]>;

/** Privacy-policy version recorded on consent rows. Phase 2 sets this to the
 *  merge date of the policy section and privacyCopy.test asserts equality. */
export const POLICY_VERSION = "2026-10-22";

export function validateEventProps(
  name: string,
  props: unknown,
): { ok: true; name: EventName; props: Record<string, unknown> } | { ok: false; reason: "unknown_event" | "invalid_props" } {
  if (!(name in EVENTS)) return { ok: false, reason: "unknown_event" };
  const spec = EVENTS[name as EventName];
  const parsed = spec.props.safeParse(props);
  if (!parsed.success) return { ok: false, reason: "invalid_props" };
  return { ok: true, name: name as EventName, props: parsed.data as Record<string, unknown> };
}

/** Spec table row count; kept for the registry test (F26-AC-01). */
export const EVENT_REGISTRY_COUNT = 144 as const;
