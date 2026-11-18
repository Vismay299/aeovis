// Portions copied from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/chat/ChatMessage.tsx:25-28 (humanizeToolName)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ToolArea } from "../server/tools/types.ts";

export type TableFormat =
  | "int"
  | "usd"
  | "pct"
  | "position"
  | "date"
  | "url"
  | "text";

export type TableColumn = {
  key: string;
  label: string;
  format?: TableFormat;
};

export type KeyValueField = {
  /** Dotted path resolved against the tool output (e.g. "panel.active"). */
  key: string;
  label: string;
  format?: TableFormat;
};

export type RenderSpec =
  | {
      kind: "table";
      rowsPath: string;
      columns: TableColumn[];
      totalPath?: string;
    }
  | { kind: "keyValue"; fields: KeyValueField[] }
  | { kind: "text"; path: string }
  | {
      kind: "job";
      statusPath: string;
      donePath?: string;
      totalPath?: string;
    }
  | { kind: "context" }
  | { kind: "skill" }
  | { kind: "auto" };

export type ToolPresentation = {
  title: string;
  running: string;
  done: string;
  area: ToolArea;
  render: RenderSpec;
};

const keywordColumns: TableColumn[] = [
  { key: "keyword", label: "Keyword" },
  { key: "searchVolume", label: "Volume", format: "int" },
  { key: "keywordDifficulty", label: "Difficulty", format: "int" },
  { key: "cpc", label: "CPC", format: "usd" },
  { key: "intent", label: "Intent" },
];

/**
 * Presentation for every TOOL_NAMES entry plus `activate_skill`.
 * Explicit RenderSpecs follow F22 §6.6.1; everything else is `auto`
 * (the card falls back to `autoTable(data)` at render time).
 *
 * SPEC GAP (F22 §6.6.1): the spec names tables by label ("Competitors
 * named", "Own", "Issue") but not their output keys. Column keys below
 * follow the registered zod output schemas; the frontend T2 subtask
 * confirms them against live tool output.
 *
 * SPEC GAP: `activate_skill` has no catalog area. It is filed under
 * "visibility" (the assistant's home area); the skill card ignores area.
 */
export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  // F07 — memory
  get_project_context: {
    title: "Workspace memory",
    running: "Reading workspace memory…",
    done: "Read workspace memory",
    area: "memory",
    render: { kind: "context" },
  },
  update_project_context: {
    title: "Workspace memory",
    running: "Updating workspace memory…",
    done: "Updated workspace memory",
    area: "memory",
    render: { kind: "context" },
  },
  // F08 + F22 — questions
  list_questions: {
    title: "Questions",
    running: "Loading questions…",
    done: "Loaded questions",
    area: "questions",
    render: { kind: "auto" },
  },
  add_questions: {
    title: "Questions",
    running: "Adding questions…",
    done: "Added questions",
    area: "questions",
    render: { kind: "auto" },
  },
  research_questions: {
    title: "Question research",
    running: "Researching questions…",
    done: "Researched questions",
    area: "questions",
    render: { kind: "auto" },
  },
  generate_questions: {
    title: "Question ideas",
    running: "Drafting questions…",
    done: "Drafted questions",
    area: "questions",
    render: { kind: "auto" },
  },
  // F13 + F22 — keywords
  list_saved_keywords: {
    title: "Saved keywords",
    running: "Loading saved keywords…",
    done: "Loaded saved keywords",
    area: "keywords",
    render: { kind: "table", rowsPath: "rows", columns: keywordColumns, totalPath: "totalCount" },
  },
  save_keywords: {
    title: "Saved keywords",
    running: "Saving keywords…",
    done: "Saved keywords",
    area: "keywords",
    render: { kind: "auto" },
  },
  research_keywords: {
    title: "Keyword research",
    running: "Researching keywords…",
    done: "Researched keywords",
    area: "keywords",
    render: { kind: "table", rowsPath: "rows", columns: keywordColumns },
  },
  get_serp_results: {
    title: "SERP results",
    running: "Reading search results…",
    done: "Read search results",
    area: "keywords",
    render: {
      kind: "table",
      rowsPath: "items",
      columns: [
        { key: "rank", label: "Rank", format: "int" },
        { key: "title", label: "Title" },
        { key: "domain", label: "Domain" },
        { key: "url", label: "URL", format: "url" },
      ],
    },
  },
  find_serp_competitors: {
    title: "SERP competitors",
    running: "Finding competitors…",
    done: "Found competitors",
    area: "domain",
    render: { kind: "auto" },
  },
  // F14 — domain
  get_domain_overview: {
    title: "Domain overview",
    running: "Loading domain overview…",
    done: "Loaded domain overview",
    area: "domain",
    render: { kind: "auto" },
  },
  get_ranked_keywords: {
    title: "Ranked keywords",
    running: "Loading ranked keywords…",
    done: "Loaded ranked keywords",
    area: "domain",
    render: { kind: "auto" },
  },
  // F15 — rank tracking
  list_rank_trackers: {
    title: "Rank trackers",
    running: "Loading rank trackers…",
    done: "Loaded rank trackers",
    area: "rank_tracking",
    render: { kind: "auto" },
  },
  get_rank_tracker: {
    title: "Rank tracker",
    running: "Loading rank tracker…",
    done: "Loaded rank tracker",
    area: "rank_tracking",
    render: { kind: "auto" },
  },
  add_rank_tracking_keywords: {
    title: "Tracking keywords",
    running: "Adding tracked keywords…",
    done: "Added tracked keywords",
    area: "rank_tracking",
    render: { kind: "auto" },
  },
  run_rank_check: {
    title: "Rank check",
    running: "Running rank check…",
    done: "Ran rank check",
    area: "rank_tracking",
    render: { kind: "auto" },
  },
  // F16 — backlinks
  get_backlinks_overview: {
    title: "Backlinks overview",
    running: "Loading backlinks…",
    done: "Loaded backlinks",
    area: "backlinks",
    render: { kind: "auto" },
  },
  list_backlinks: {
    title: "Backlinks",
    running: "Loading backlinks…",
    done: "Loaded backlinks",
    area: "backlinks",
    render: { kind: "auto" },
  },
  list_referring_domains: {
    title: "Referring domains",
    running: "Loading referring domains…",
    done: "Loaded referring domains",
    area: "backlinks",
    render: { kind: "auto" },
  },
  get_backlink_history: {
    title: "Backlink history",
    running: "Loading backlink history…",
    done: "Loaded backlink history",
    area: "backlinks",
    render: { kind: "auto" },
  },
  // F17 — local
  search_local_businesses: {
    title: "Local businesses",
    running: "Searching businesses…",
    done: "Found businesses",
    area: "local",
    render: { kind: "auto" },
  },
  get_local_serp_results: {
    title: "Local results",
    running: "Reading local results…",
    done: "Read local results",
    area: "local",
    render: { kind: "auto" },
  },
  get_local_rank_grid: {
    title: "Rank grid",
    running: "Loading rank grid…",
    done: "Loaded rank grid",
    area: "local",
    render: { kind: "auto" },
  },
  get_business_profile: {
    title: "Business profile",
    running: "Loading business profile…",
    done: "Loaded business profile",
    area: "local",
    render: { kind: "auto" },
  },
  get_business_reviews: {
    title: "Business reviews",
    running: "Loading reviews…",
    done: "Loaded reviews",
    area: "local",
    render: { kind: "auto" },
  },
  get_business_updates: {
    title: "Business updates",
    running: "Loading updates…",
    done: "Loaded updates",
    area: "local",
    render: { kind: "auto" },
  },
  get_google_business_questions: {
    title: "Business Q&A",
    running: "Loading questions…",
    done: "Loaded questions",
    area: "local",
    render: { kind: "auto" },
  },
  list_business_categories: {
    title: "Business categories",
    running: "Loading categories…",
    done: "Loaded categories",
    area: "local",
    render: { kind: "auto" },
  },
  // F18 — audit
  run_site_audit: {
    title: "Site audit",
    running: "Starting site audit…",
    done: "Started site audit",
    area: "audit",
    render: { kind: "auto" },
  },
  get_site_audit_status: {
    title: "Site audit",
    running: "Checking audit status…",
    done: "Checked audit status",
    area: "audit",
    render: { kind: "job", statusPath: "status", donePath: "pagesCrawled", totalPath: "pagesTotal" },
  },
  get_site_audit_issues: {
    title: "Audit issues",
    running: "Loading audit issues…",
    done: "Loaded audit issues",
    area: "audit",
    render: {
      kind: "table",
      rowsPath: "groups",
      columns: [
        { key: "title", label: "Issue" },
        { key: "severity", label: "Severity" },
        { key: "pages", label: "Pages", format: "int" },
      ],
    },
  },
  get_site_audit_pages: {
    title: "Audit pages",
    running: "Loading audit pages…",
    done: "Loaded audit pages",
    area: "audit",
    render: { kind: "auto" },
  },
  list_site_audits: {
    title: "Site audits",
    running: "Loading site audits…",
    done: "Loaded site audits",
    area: "audit",
    render: { kind: "auto" },
  },
  // F19 — indexnow
  submit_indexnow_urls: {
    title: "IndexNow",
    running: "Submitting URLs…",
    done: "Submitted URLs",
    area: "indexnow",
    render: { kind: "auto" },
  },
  // F20 — analytics
  get_google_analytics_organic_overview: {
    title: "Organic overview",
    running: "Loading overview…",
    done: "Loaded overview",
    area: "analytics",
    render: { kind: "auto" },
  },
  get_google_analytics_organic_landing_pages: {
    title: "Landing pages",
    running: "Loading landing pages…",
    done: "Loaded landing pages",
    area: "analytics",
    render: { kind: "auto" },
  },
  get_google_analytics_page_performance: {
    title: "Page performance",
    running: "Loading page performance…",
    done: "Loaded page performance",
    area: "analytics",
    render: { kind: "auto" },
  },
  get_google_analytics_key_events: {
    title: "Key events",
    running: "Loading key events…",
    done: "Loaded key events",
    area: "analytics",
    render: { kind: "auto" },
  },
  get_google_analytics_traffic_acquisition: {
    title: "Traffic acquisition",
    running: "Loading acquisition…",
    done: "Loaded acquisition",
    area: "analytics",
    render: { kind: "auto" },
  },
  get_google_analytics_ecommerce_performance: {
    title: "Ecommerce",
    running: "Loading ecommerce…",
    done: "Loaded ecommerce",
    area: "analytics",
    render: { kind: "auto" },
  },
  get_google_analytics_site_search: {
    title: "Site search",
    running: "Loading site search…",
    done: "Loaded site search",
    area: "analytics",
    render: { kind: "auto" },
  },
  get_google_analytics_audience_breakdown: {
    title: "Audience",
    running: "Loading audience…",
    done: "Loaded audience",
    area: "analytics",
    render: { kind: "auto" },
  },
  get_google_analytics_measurement_health: {
    title: "Measurement health",
    running: "Checking measurement…",
    done: "Checked measurement",
    area: "analytics",
    render: { kind: "auto" },
  },
  get_search_opportunities: {
    title: "Opportunities",
    running: "Finding opportunities…",
    done: "Found opportunities",
    area: "analytics",
    render: { kind: "auto" },
  },
  // F22 — own visibility tools
  get_measurement_status: {
    title: "Measurement",
    running: "Checking measurement…",
    done: "Checked measurement",
    area: "visibility",
    render: {
      kind: "keyValue",
      fields: [
        { key: "panel.approvedVersion", label: "Panel version" },
        { key: "panel.dirty", label: "Unapproved changes" },
        { key: "panel.active", label: "Active questions", format: "int" },
        { key: "panel.branded", label: "Branded questions", format: "int" },
        { key: "enginesConfigured", label: "Engines" },
      ],
    },
  },
  list_scans: {
    title: "Scans",
    running: "Loading scans…",
    done: "Loaded scans",
    area: "visibility",
    render: {
      kind: "table",
      rowsPath: "scans",
      columns: [
        { key: "scannedAt", label: "Date", format: "date" },
        { key: "visibilityPct", label: "Visibility", format: "pct" },
        { key: "promptsTracked", label: "Questions", format: "int" },
        { key: "promptsMentioned", label: "Mentioned", format: "int" },
      ],
      totalPath: "totalCount",
    },
  },
  get_scan_report: {
    title: "Scan report",
    running: "Loading scan report…",
    done: "Loaded scan report",
    area: "visibility",
    render: {
      kind: "table",
      rowsPath: "rows",
      columns: [
        { key: "question", label: "Question", format: "text" },
        { key: "engine", label: "Engine" },
        { key: "answered", label: "Answered" },
        { key: "mentioned", label: "Mentioned" },
        { key: "cited", label: "Cited" },
        { key: "competitorsNamed", label: "Competitors named" },
      ],
      totalPath: "totalCount",
    },
  },
  get_scan_answer: {
    title: "Scan answer",
    running: "Loading scan answer…",
    done: "Loaded scan answer",
    area: "visibility",
    render: { kind: "text", path: "answer" },
  },
  get_scan_sources: {
    title: "Scan sources",
    running: "Loading scan sources…",
    done: "Loaded scan sources",
    area: "visibility",
    render: {
      kind: "table",
      rowsPath: "sources",
      columns: [
        { key: "domain", label: "Domain" },
        { key: "domainType", label: "Type" },
        { key: "answersCiting", label: "Answers citing", format: "int" },
        { key: "isOwn", label: "Own" },
      ],
      totalPath: "totalCount",
    },
  },
  get_scan_status: {
    title: "Scan status",
    running: "Checking scan status…",
    done: "Checked scan status",
    area: "visibility",
    render: { kind: "job", statusPath: "status" },
  },
  run_scan: {
    title: "Scan",
    running: "Starting scan…",
    done: "Started scan",
    area: "visibility",
    render: { kind: "auto" },
  },
  explore_question: {
    title: "Answer engines",
    running: "Asking answer engines…",
    done: "Asked answer engines",
    area: "visibility",
    render: { kind: "auto" },
  },
  get_explore_run: {
    title: "Explore run",
    running: "Checking explore run…",
    done: "Checked explore run",
    area: "visibility",
    render: { kind: "job", statusPath: "status", donePath: "completedModels" },
  },
  get_question_history: {
    title: "Question history",
    running: "Loading question history…",
    done: "Loaded question history",
    area: "visibility",
    render: { kind: "auto" },
  },
  get_question_answer: {
    title: "Question answer",
    running: "Loading question answer…",
    done: "Loaded question answer",
    area: "visibility",
    render: { kind: "text", path: "text" },
  },
  // F22 — own pricing/site/content tools
  estimate_price: {
    title: "Price estimate",
    running: "Estimating price…",
    done: "Estimated price",
    area: "pricing",
    render: { kind: "auto" },
  },
  get_search_console_performance: {
    title: "Search performance",
    running: "Loading search performance…",
    done: "Loaded search performance",
    area: "search_console",
    render: {
      kind: "table",
      rowsPath: "rows",
      columns: [
        { key: "query", label: "Query" },
        { key: "clicks", label: "Clicks", format: "int" },
        { key: "impressions", label: "Impressions", format: "int" },
        { key: "ctr", label: "CTR", format: "pct" },
        { key: "avg_position", label: "Position", format: "position" },
      ],
    },
  },
  map_site_pages: {
    title: "Site pages",
    running: "Mapping site pages…",
    done: "Mapped site pages",
    area: "site",
    render: { kind: "auto" },
  },
  read_pages: {
    title: "Page content",
    running: "Reading pages…",
    done: "Read pages",
    area: "site",
    render: { kind: "text", path: "pages[*].text" },
  },
  check_ai_crawler_access: {
    title: "AI crawler access",
    running: "Checking crawler access…",
    done: "Checked crawler access",
    area: "site",
    render: {
      kind: "table",
      rowsPath: "bots",
      columns: [
        { key: "name", label: "Crawler" },
        { key: "operator", label: "Operator" },
        { key: "purpose", label: "Purpose" },
        { key: "status", label: "Status" },
      ],
    },
  },
  start_content_draft: {
    title: "Content draft",
    running: "Starting content draft…",
    done: "Started content draft",
    area: "content",
    render: { kind: "auto" },
  },
  list_content_items: {
    title: "Content items",
    running: "Loading content items…",
    done: "Loaded content items",
    area: "content",
    render: { kind: "auto" },
  },
  // F23 — reports
  list_reports: {
    title: "Reports",
    running: "Loading reports…",
    done: "Loaded reports",
    area: "reports",
    render: {
      kind: "table",
      rowsPath: "reports",
      columns: [
        { key: "title", label: "Title" },
        { key: "skill", label: "Skill" },
        { key: "updatedAt", label: "Updated", format: "date" },
      ],
      totalPath: "totalCount",
    },
  },
  get_report: {
    title: "Report",
    running: "Loading report…",
    done: "Loaded report",
    area: "reports",
    render: {
      kind: "keyValue",
      fields: [
        { key: "report.title", label: "Title" },
        { key: "report.skill", label: "Skill" },
        { key: "report.htmlBytes", label: "Size" },
        { key: "report.updatedAt", label: "Updated", format: "date" },
      ],
    },
  },
  save_report: {
    title: "Report",
    running: "Saving report…",
    done: "Saved report",
    area: "reports",
    render: {
      kind: "keyValue",
      fields: [
        { key: "title", label: "Title" },
        { key: "created", label: "Created" },
        { key: "htmlBytes", label: "Size" },
        { key: "sanitized.changed", label: "Changes on save" },
      ],
    },
  },
  list_report_templates: {
    title: "Report templates",
    running: "Loading report templates…",
    done: "Loaded report templates",
    area: "reports",
    render: {
      kind: "table",
      rowsPath: "templates",
      columns: [
        { key: "name", label: "Name" },
        { key: "description", label: "Description" },
      ],
    },
  },
  // F21 — skill activation (not in TOOL_NAMES; always presented)
  activate_skill: {
    title: "Skill",
    running: "Loading skill…",
    done: "Loaded skill",
    area: "visibility",
    render: { kind: "skill" },
  },
};

/** Copy of openseo:src/client/components/chat/ChatMessage.tsx:25-28 `humanizeToolLabel`. */
export function humanizeToolName(name: string): string {
  const pretty = name.replace(/^tool-/, "").replace(/_/g, " ");
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

export type AutoTableColumn = { key: string; label: string };

export type AutoTableResult =
  | {
      kind: "table";
      columns: AutoTableColumn[];
      rows: Array<Record<string, unknown>>;
      total: number;
    }
  | {
      kind: "keyValue";
      entries: Array<{
        key: string;
        label: string;
        value: string | number | boolean | null;
      }>;
    }
  | { kind: "json"; value: unknown };

const MAX_AUTO_COLUMNS = 8;
const MAX_AUTO_KEY_ROWS = 5;
const MAX_AUTO_ROWS = 20;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Fallback renderer for `auto` specs (F22 §6.6.1): exactly one top-level
 * array of objects → table of the union of scalar keys of the first 5 rows
 * (≤ 8 columns, humanised labels), first 20 rows with the full count;
 * else key-value of top-level scalars; else the raw JSON.
 *
 * Link policy lives in the card renderers, not here: URL-looking strings
 * render as plain text inside untrusted paths, and through
 * `SafeExternalLink` elsewhere.
 */
export function autoTable(data: unknown): AutoTableResult {
  if (isPlainObject(data)) {
    const entries = Object.entries(data);
    const arrays = entries.filter((entry): entry is [string, unknown[]] =>
      Array.isArray(entry[1]),
    );
    if (arrays.length === 1) {
      const rows = arrays[0][1];
      if (rows.every(isPlainObject)) {
        const columns: AutoTableColumn[] = [];
        for (const row of rows.slice(0, MAX_AUTO_KEY_ROWS)) {
          for (const key of Object.keys(row)) {
            if (
              isScalar(row[key]) &&
              !columns.some((column) => column.key === key)
            ) {
              columns.push({ key, label: humanizeToolName(key) });
              if (columns.length >= MAX_AUTO_COLUMNS) break;
            }
          }
          if (columns.length >= MAX_AUTO_COLUMNS) break;
        }
        return {
          kind: "table",
          columns,
          rows: rows.slice(0, MAX_AUTO_ROWS).map((row) => {
            const projected: Record<string, unknown> = {};
            for (const column of columns) {
              if (column.key in row) projected[column.key] = row[column.key];
            }
            return projected;
          }),
          total: rows.length,
        };
      }
    }
    const scalars = entries.filter((entry): entry is [string, string | number | boolean | null] =>
      isScalar(entry[1]),
    );
    if (scalars.length > 0) {
      return {
        kind: "keyValue",
        entries: scalars.map(([key, value]) => ({
          key,
          label: humanizeToolName(key),
          value,
        })),
      };
    }
  }
  return { kind: "json", value: data };
}
