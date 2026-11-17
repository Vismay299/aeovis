// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/reports/sharePage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// The public face of a shared report, `/s/<token>`: a slim bar and the
// document in the same sandboxed frame the in-app viewer uses. Rendered to a
// static string on the server rather than served as a React route, because the
// reader is usually someone who has never opened Perceev: no app bundle, no
// hydration — the frame is in the first response, and the only script is the
// Share button's clipboard handler. Every interpolated value goes through
// escapeHtml, because the title and summary are report content.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";
import { SHARE_TOKEN_PATTERN } from "../../shared/report-share.ts";
import { REPORT_IFRAME_SANDBOX } from "../../shared/report-sandbox.ts";
import { isFeatureEnabled as isFeatureEnabledDefault } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";

/** The row the wrapper and the raw document both read (migration 150's `get_shared_report`). */
export type SharedReportRow = {
  id: string;
  brand_key: string;
  title: string;
  summary: string;
  skill: string | null;
  updated_at: string;
  website_host: string | null;
  workspace_active: boolean;
  sanitizer_version: number;
};

export type SharePageDeps = {
  getSupabaseAdmin?: () => SupabaseClient | null;
  isFeatureEnabled?: (name: FeatureName, brandKey?: string) => Promise<boolean>;
  now?: () => Date;
};

/** Escape every interpolated value: report content is never trusted HTML. */
export function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

// Share sheet on touch devices; the clipboard elsewhere. The label is the feedback.
export const SHARE_SCRIPT = `
document.getElementById("share").addEventListener("click",async function(){
  var url=location.href,label=this.querySelector("span");
  if(matchMedia("(pointer: coarse)").matches&&navigator.share){
    try{await navigator.share({title:document.title,url:url})}catch(e){}
    return;
  }
  try{await navigator.clipboard.writeText(url);label.textContent="Link copied"}
  catch(e){label.textContent="Copy failed"}
  setTimeout(function(){label.textContent="Share"},2000);
});`;

export const SHARE_SCRIPT_SHA256 = "y68KXhaYtyebPWItup5TzVWEMfDkj462A2TWYTaBmtI=";

export const WRAPPER_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; script-src 'sha256-" +
  SHARE_SCRIPT_SHA256 +
  "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// The page's own light and dark palettes, so the bar matches the product
// without loading its stylesheet. Dark follows the OS: an anonymous reader
// has no stored preference. `--primary` is Perceev's brand, not OpenSEO's.
const STYLES = `
:root{color-scheme:light dark;--bg:oklch(97% 0 0);--surface:oklch(100% 0 0);--border:oklch(92% 0 0);--text:oklch(20% 0 0);--muted:oklch(20% 0 0 / .5);--primary:#3730CE;--primary-text:oklch(100% 0 0);--ghost-hover:oklch(20% 0 0 / .08)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(12% 0 0);--surface:oklch(18% 0 0);--border:oklch(27% 0 0);--text:oklch(92% 0 0);--muted:oklch(92% 0 0 / .5);--primary:#5B54F0;--ghost-hover:oklch(92% 0 0 / .1)}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:8px 16px;background:var(--surface);border-bottom:1px solid var(--border)}
.title{width:100%;min-width:0}
@media (min-width:640px){.title{width:auto;flex:1}}
h1{margin:0;font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{margin:0;font-size:12px;color:var(--muted)}
.actions{display:flex;flex-shrink:0;align-items:center;gap:8px}
.btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid transparent;border-radius:6px;font:inherit;font-weight:600;color:inherit;background:transparent;cursor:pointer;text-decoration:none}
.btn:hover{background:var(--ghost-hover)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-text)}
.btn.primary:hover{filter:brightness(.92)}
.btn svg{width:16px;height:16px}
iframe{flex:1;min-height:0;width:100%;border:0;background:var(--surface)}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center}
main h1{white-space:normal;font-size:18px}
main p{max-width:28rem;margin:0;color:var(--muted)}
`;

const TRY_PERCEEV_URL = "https://perceev.com/?utm_source=shared_report";

const MAX_DESCRIPTION_CHARS = 200;

/**
 * The link preview's description: the summary's first non-empty line, capped.
 * The summary is prose, and no attempt is made to strip markup — a stray
 * character in a preview is a smaller problem than a stripper that eats a
 * leading minus sign off a number.
 */
export function shareDescription(summary: string): string {
  const line = String(summary)
    .split("\n")
    .map((raw) => raw.trim())
    .find((raw) => raw.length > 0);
  if (!line) return "";
  return line.length > MAX_DESCRIPTION_CHARS
    ? `${line.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`
    : line;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "3 h ago" for an ISO timestamp; "just now" under a minute. */
export function formatUpdatedAgo(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMs = now.getTime() - then;
  if (diffMs < 0) return "just now";
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (diffMs < MINUTE) return "just now";
  if (diffMs < HOUR) return `${Math.floor(diffMs / MINUTE)} min ago`;
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)} h ago`;
  const days = Math.floor(diffMs / DAY);
  if (days < 365) return days <= 1 ? "yesterday" : `${days} days ago`;
  const date = new Date(then);
  return `on ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export type SharePageContent = {
  title: string;
  description: string;
  canonical: string;
  imageUrl: string;
  token: string;
  updatedAgo: string;
};

/** The public page: the frame pointing at the raw document, in the first response. */
export function renderSharePageHtml(input: SharePageContent): string {
  const title = escapeHtml(input.title);
  const canonical = escapeHtml(input.canonical);
  const imageUrl = escapeHtml(input.imageUrl);
  const token = escapeHtml(input.token);
  const updatedAgo = escapeHtml(input.updatedAgo);
  const imageAlt = `${title} · Perceev`;
  const descriptionTags = input.description
    ? `<meta property="og:description" content="${escapeHtml(input.description)}">\n<meta name="description" content="${escapeHtml(input.description)}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${title} · Perceev</title>
<meta property="og:type" content="article">
<meta property="og:site_name" content="Perceev">
<meta property="og:title" content="${title}">
<meta name="twitter:title" content="${title}">
${descriptionTags}
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${imageAlt}">
<meta name="twitter:image" content="${imageUrl}">
<meta name="twitter:image:alt" content="${imageAlt}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico">
<style>${STYLES}</style>
</head>
<body>
<header>
<div class="title">
<h1>${title}</h1>
<p class="meta">Made with Perceev · Updated ${updatedAgo}</p>
</div>
<div class="actions">
<button type="button" class="btn" id="share">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
<span>Share</span>
</button>
<a class="btn primary" href="${TRY_PERCEEV_URL}" target="_blank" rel="noreferrer">Try Perceev</a>
</div>
</header>
<iframe src="/s/${token}/raw" sandbox="${REPORT_IFRAME_SANDBOX}" referrerpolicy="no-referrer" title="${title}"></iframe>
<script>${SHARE_SCRIPT}</script>
</body>
</html>`;
}

/** A dead end: 404, and the report's own title is content the link no longer grants. */
export function renderUnavailableHtml(heading: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Report unavailable · Perceev</title>
<link rel="icon" href="/favicon.ico">
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(detail)}</p>
<a class="btn primary" href="${TRY_PERCEEV_URL}" target="_blank" rel="noreferrer">Try Perceev</a>
</main>
</body>
</html>`;
}

const SHARE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  // The page carries the title and summary in its head, so a revoked link
  // must not live on in an intermediary cache.
  "Cache-Control": "no-store",
  "Content-Security-Policy": WRAPPER_CSP,
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/**
 * `GET /s/[token]` (§6.2.6). The same token lookup as the raw document; dead
 * ends are 404 pages that name no report title.
 */
export async function handleSharePage(
  token: string,
  request: Request,
  deps: SharePageDeps = {}
): Promise<Response> {
  const unavailable = (heading: string, detail: string) =>
    new Response(renderUnavailableHtml(heading, detail), { status: 404, headers: SHARE_HEADERS });
  const missing = () =>
    unavailable(
      "This report isn't shared.",
      "The link may have been turned off, or the report may have been deleted."
    );

  if (!SHARE_TOKEN_PATTERN.test(token)) return missing();

  const loadAdmin = deps.getSupabaseAdmin ?? getSupabaseAdmin;
  const admin = loadAdmin();
  if (!admin) throw new Error("[reports] storage is not configured");
  const { data, error } = await admin.rpc("get_shared_report", { p_token: token });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as SharedReportRow | null | undefined;
  if (!row) return missing();
  if (!row.workspace_active) {
    return unavailable("This report isn't available.", "Its workspace is no longer active.");
  }

  const flag = deps.isFeatureEnabled ?? isFeatureEnabledDefault;
  if (!(await flag("report_sharing", row.brand_key))) return missing();

  const description = shareDescription(row.summary);
  const canonical = `${new URL(request.url).origin}/s/${token}`;
  const html = renderSharePageHtml({
    title: row.title,
    description,
    canonical,
    // Query parameters only version the URL; the image route reads its
    // content from the authorized report, never from the parameters.
    imageUrl: `${canonical}/og.png?v=${encodeURIComponent(row.updated_at)}`,
    token,
    updatedAgo: formatUpdatedAgo(row.updated_at, deps.now?.() ?? new Date()),
  });
  return new Response(html, { status: 200, headers: SHARE_HEADERS });
}
