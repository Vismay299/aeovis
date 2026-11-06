// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/audit-issues.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type IssueSeverity = "critical" | "warning" | "info";

export type IssueCategory =
  | "crawl"
  | "links"
  | "content"
  | "indexability"
  | "performance"
  | "ai_access"
  | "structured_data"
  | "social"
  | "international";

export type IssueScope = "page" | "site";

export interface AuditIssueDescriptor {
  severity: IssueSeverity;
  category: IssueCategory;
  scope: IssueScope;
  title: string;
  explanation: string;
  howToFix: string;
}

export const AUDIT_ISSUE_TYPES = {
  // --- 30 OpenSEO issue types ---
  "blocked-page": {
    severity: "critical",
    category: "crawl",
    scope: "page",
    title: "Crawler was blocked",
    explanation:
      "The site returned a bot challenge or access denial (e.g. a Cloudflare challenge or a 403) instead of the page. We report this honestly rather than pretending the page is broken — but it means this page could not be audited, and other crawlers like search engines may face similar friction.",
    howToFix:
      'If you own this site, allowlist the "PerceevAudit" user agent in your WAF/bot-protection settings (on Cloudflare: a WAF custom rule that skips bot protection when the user agent contains "PerceevAudit"; on some free tiers you may need to relax bot protection). Then re-run the audit.',
  },
  "javascript-rendering-suspected": {
    severity: "warning",
    category: "crawl",
    scope: "page",
    title: "Content may require JavaScript",
    explanation:
      "The page's HTML contains a JavaScript app container with very little readable content and no headings, links, or images. The page may load its content in the browser, or it was still loading when rendered. Content checks were skipped because this HTML may not represent the complete page.",
    howToFix:
      'If this audit did not render JavaScript, start a new audit with "Render JavaScript" enabled to check the loaded content. For reliable crawling, serve important content and navigation in the initial HTML using server-side rendering or prerendering. This warning does not prove that search engines cannot index the page.',
  },
  "rate-limited-page": {
    severity: "warning",
    category: "crawl",
    scope: "page",
    title: "Rate limited (429)",
    explanation:
      "The server answered 429 Too Many Requests, so this page could not be audited. The crawler waits before retrying when the site's cooldown fits within the audit time limit.",
    howToFix:
      'Raise the rate limit for crawlers, or allowlist the "PerceevAudit" user agent in your rate-limiting rules (on Cloudflare: a rate-limiting rule exception matching that user agent). Then re-run the audit. Re-running with fewer pages also helps if the limit is strict.',
  },
  "crawl-rate-limited": {
    severity: "warning",
    category: "crawl",
    scope: "site",
    title: "Crawl stopped early: rate limit",
    explanation:
      "The site asked the crawler to wait longer than the audit time limit allowed. We stopped requesting pages. This report is incomplete; URLs we did not fetch are not recorded as broken or rate limited.",
    howToFix:
      "Re-run the audit after the site's rate limit resets, or ask the site owner to allow the PerceevAudit crawler.",
  },
  "server-error": {
    severity: "critical",
    category: "links",
    scope: "page",
    title: "Server error (5xx)",
    explanation:
      "The page returned a 5xx server error. Search engines that repeatedly see server errors will crawl the site less and may drop the page from the index.",
    howToFix:
      "Check the server logs for this URL and fix the underlying error. If the page is gone, return a 404/410 or redirect it to a relevant page instead of erroring.",
  },
  "broken-internal-link": {
    severity: "critical",
    category: "links",
    scope: "page",
    title: "Broken internal link",
    explanation:
      "This page links to an internal URL that returns an error status (4xx/5xx). Broken links waste crawl budget, leak link equity, and frustrate users — they are among the most common and most damaging technical SEO issues.",
    howToFix:
      "Update the link to point at the correct live URL, or remove it. If the target was moved, prefer linking directly to the new URL rather than relying on a redirect.",
  },
  "missing-title": {
    severity: "critical",
    category: "content",
    scope: "page",
    title: "Missing title tag",
    explanation:
      "The page has no <title>. The title is the strongest on-page relevance signal and the headline shown in search results; without it search engines generate one themselves, usually badly.",
    howToFix:
      "Add a unique, descriptive <title> of roughly 50–60 characters that includes the page's primary topic.",
  },
  "broken-page": {
    severity: "warning",
    category: "links",
    scope: "page",
    title: "Page returns an error (4xx)",
    explanation:
      "This crawled URL returned a client error (e.g. 404). If it is referenced from your sitemap or other pages, crawlers keep wasting requests on it.",
    howToFix:
      "If the page should exist, restore it. If it is intentionally gone, remove it from the sitemap and internal links, and consider a 301 redirect to the closest live page.",
  },
  "duplicate-title": {
    severity: "warning",
    category: "content",
    scope: "page",
    title: "Duplicate title",
    explanation:
      "Multiple pages share the same title tag. Search engines use titles to differentiate pages; duplicates make pages compete with each other and depress click-through rates.",
    howToFix:
      "Write a unique title for each page describing its specific content. For templated pages, include the distinguishing attribute (name, category, location) in the template.",
  },
  "duplicate-meta-description": {
    severity: "warning",
    category: "content",
    scope: "page",
    title: "Duplicate meta description",
    explanation:
      "Multiple pages share the same meta description, so search results show identical snippets and users cannot tell the pages apart.",
    howToFix:
      "Write a unique meta description per page, or remove the duplicated one entirely — search engines will generate a snippet from page content, which beats a wrong duplicate.",
  },
  "duplicate-content": {
    severity: "warning",
    category: "content",
    scope: "page",
    title: "Duplicate page content",
    explanation:
      "Two or more URLs serve byte-identical visible text. Search engines pick one version to index and ignore the rest, and ranking signals get split across the duplicates.",
    howToFix:
      "Consolidate duplicates: pick the canonical URL, add rel=canonical from the others, and 301-redirect duplicate URLs where possible (common causes: trailing-slash variants, URL parameters, http/https or www variants).",
  },
  "missing-meta-description": {
    severity: "warning",
    category: "content",
    scope: "page",
    title: "Missing meta description",
    explanation:
      "The page has no meta description. Search engines will assemble a snippet from page text, which is often less compelling and hurts click-through rate.",
    howToFix:
      "Add a meta description of roughly 70–160 characters that summarizes the page and gives a reason to click.",
  },
  "missing-h1": {
    severity: "warning",
    category: "content",
    scope: "page",
    title: "Missing H1 heading",
    explanation:
      "The page has no H1. The H1 tells users and search engines what the page is about; pages without one tend to have weaker topical clarity.",
    howToFix:
      "Add a single H1 that states the page's main topic, consistent with the title tag.",
  },
  "multiple-h1": {
    severity: "warning",
    category: "content",
    scope: "page",
    title: "Multiple H1 headings",
    explanation:
      "The page has more than one H1, which dilutes the main-topic signal and usually indicates a templating mistake (e.g. a logo and a headline both marked up as H1).",
    howToFix:
      "Keep one H1 for the page's main heading and demote the others to H2/H3 (or unstyled elements for non-headings like logos).",
  },
  "redirect-chain": {
    severity: "warning",
    category: "links",
    scope: "page",
    title: "Redirect chain",
    explanation:
      "Reaching the final page requires two or more consecutive redirects. Each hop adds latency, leaks link equity, and burns crawl budget; long chains may not be followed at all.",
    howToFix:
      "Point the first URL (and any internal links) directly at the final destination so there is at most one redirect.",
  },
  "redirect-loop": {
    severity: "warning",
    category: "links",
    scope: "page",
    title: "Redirect loop",
    explanation:
      "This redirect eventually points back to itself, so the URL never resolves. Browsers and crawlers give up with an error.",
    howToFix:
      "Trace the redirect rules for this URL and break the cycle so the chain terminates at a real 200 page.",
  },
  "canonical-conflict": {
    severity: "warning",
    category: "indexability",
    scope: "page",
    title: "Conflicting canonical signals",
    explanation:
      "The page declares different canonical URLs in its HTML <link rel=canonical> and its HTTP Link header. When signals conflict, search engines ignore both and choose their own canonical.",
    howToFix:
      "Pick one canonical URL and declare it in exactly one place (HTML head is the most common); remove or align the other declaration.",
  },
  "thin-content": {
    severity: "warning",
    category: "content",
    scope: "page",
    title: "Thin content",
    explanation:
      "The page has very little visible text. Thin pages rarely rank, can drag down sitewide quality assessments, and (if the site renders client-side) may indicate content invisible to plain-HTML crawlers.",
    howToFix:
      "Either expand the page with genuinely useful content, noindex it, or consolidate it into a stronger page. If the content exists but is rendered by JavaScript, ensure it is server-rendered or pre-rendered.",
  },
  "images-missing-alt": {
    severity: "warning",
    category: "content",
    scope: "page",
    title: "Images missing alt text",
    explanation:
      "One or more images on the page lack alt attributes. Alt text is an accessibility requirement and the main way search engines understand images.",
    howToFix:
      'Add descriptive alt text to meaningful images; use an empty alt (alt="") only for purely decorative ones.',
  },
  "orphan-page": {
    severity: "warning",
    category: "links",
    scope: "page",
    title: "Orphan page",
    explanation:
      "No crawled page links to this URL — it was only discoverable via the sitemap. Pages without internal links receive little crawl attention and no internal link equity, and users can't find them by browsing.",
    howToFix:
      "Link to this page from relevant pages (navigation, related content, hub pages), or remove it from the sitemap if it shouldn't be indexed.",
  },
  "no-outgoing-links": {
    severity: "warning",
    category: "links",
    scope: "page",
    title: "Page has no outgoing links",
    explanation:
      "The page contains no links at all — a dead end. Link equity that flows into it stops there, crawlers have nowhere to go next, and users have to reach for the back button.",
    howToFix:
      "Add links to related pages, the parent category, or the homepage. If the page's navigation is rendered by JavaScript, make sure it also exists in the server-rendered HTML.",
  },
  "title-too-long": {
    severity: "info",
    category: "content",
    scope: "page",
    title: "Title too long",
    explanation:
      "The title exceeds ~60 characters, so search results will truncate it and the ending may be cut off mid-phrase.",
    howToFix:
      "Shorten the title to roughly 50–60 characters, front-loading the most important words.",
  },
  "title-too-short": {
    severity: "info",
    category: "content",
    scope: "page",
    title: "Title too short",
    explanation:
      "The title is under ~10 characters, which is usually too generic to describe the page or attract clicks.",
    howToFix:
      "Expand the title into a descriptive phrase (roughly 30–60 characters) that states what the page offers.",
  },
  "meta-description-too-long": {
    severity: "info",
    category: "content",
    scope: "page",
    title: "Meta description too long",
    explanation:
      "The meta description exceeds ~160 characters, so search engines will truncate the snippet.",
    howToFix:
      "Trim the description to roughly 70–160 characters while keeping the core message and call to action.",
  },
  "meta-description-too-short": {
    severity: "info",
    category: "content",
    scope: "page",
    title: "Meta description too short",
    explanation:
      "The meta description is under ~70 characters. Short descriptions waste the snippet space search results give you, and search engines often ignore them in favor of text pulled from the page.",
    howToFix:
      "Expand the description to roughly 70–160 characters that summarize the page and give a reason to click.",
  },
  "heading-order-skip": {
    severity: "info",
    category: "content",
    scope: "page",
    title: "Heading levels skip",
    explanation:
      "The heading hierarchy skips levels (e.g. an H4 directly after an H2). This weakens document structure for accessibility tools and content parsing.",
    howToFix:
      "Adjust heading levels so they descend one step at a time (H1 → H2 → H3) without skipping.",
  },
  "slow-response": {
    severity: "info",
    category: "performance",
    scope: "page",
    title: "Slow server response",
    explanation:
      "The HTML took over 1.5 seconds to arrive. Slow time-to-first-byte drags down every downstream performance metric and reduces crawl rate on large sites.",
    howToFix:
      "Investigate server/database time and caching for this route; serving cached or statically generated HTML usually fixes it.",
  },
  "noindex-page": {
    severity: "info",
    category: "indexability",
    scope: "page",
    title: "Page is noindex",
    explanation:
      "The page asks search engines not to index it (via robots meta tag or X-Robots-Tag header). That's often intentional — this is a heads-up, not an error.",
    howToFix:
      "If this page should rank, remove the noindex directive. If it's intentional (admin, thank-you, filter pages), no action is needed.",
  },
  "canonicalized-page": {
    severity: "info",
    category: "indexability",
    scope: "page",
    title: "Canonicalized to another URL",
    explanation:
      "The page declares a different URL as its canonical, telling search engines to index that URL instead. Fine when intentional (parameter pages, syndication) — a problem if this page was meant to rank.",
    howToFix:
      "If this page should rank on its own, set its canonical to itself. Otherwise no action is needed.",
  },
  "deep-page": {
    severity: "info",
    category: "links",
    scope: "page",
    title: "Page is deep in the site structure",
    explanation:
      "The page is 5+ clicks from the homepage. Deep pages get crawled less often and receive less link equity.",
    howToFix:
      "Add links from higher-level pages (hubs, category pages, navigation) to flatten the path to this page.",
  },

  // --- 18 Perceev issue types ---
  "crawl-blocked-by-robots": {
    severity: "critical",
    category: "crawl",
    scope: "site",
    title: "robots.txt blocks crawlers from your homepage",
    explanation:
      "Your robots.txt disallows the start page for general crawlers (the `*` group, which our PerceevAudit crawler follows). Search engines and AI crawlers that obey the same group cannot read it either, so this audit could not check your pages.",
    howToFix:
      "If the site should be found, remove or narrow the `Disallow` rule that matches `/` in the `User-agent: *` group, then run the audit again.",
  },
  "ai-search-crawler-blocked": {
    severity: "critical",
    category: "ai_access",
    scope: "page",
    title: "AI search crawlers are blocked",
    explanation:
      "robots.txt disallows this page for AI search crawlers (listed below), such as OAI-SearchBot for ChatGPT search, Claude-SearchBot or PerplexityBot. Answer engines that obey robots.txt cannot fetch it to cite it.",
    howToFix:
      "If you want this page to appear in AI answers, allow these user agents in robots.txt (for example a `User-agent: OAI-SearchBot` group with `Allow: /`). Blocking training crawlers such as GPTBot is a separate choice and does not affect search crawlers.",
  },
  "ai-agent-crawler-blocked": {
    severity: "warning",
    category: "ai_access",
    scope: "page",
    title: "AI assistant fetches are blocked",
    explanation:
      "robots.txt disallows this page for AI assistants that fetch a page when a user asks about it (for example ChatGPT-User, Claude-User or Perplexity-User). Assistants that obey robots.txt will say they cannot open it.",
    howToFix:
      "Allow these user agents for pages you want assistants to read. They fetch only on a user's request; they are not training crawlers.",
  },
  "ai-training-crawler-blocked": {
    severity: "info",
    category: "ai_access",
    scope: "site",
    title: "AI training crawlers are blocked",
    explanation:
      "robots.txt blocks some AI training crawlers (listed below) from your homepage. That is a legitimate choice and does not stop AI search or assistant crawlers.",
    howToFix:
      "No action is needed if this is intended. If you want your content used to train these models, allow the listed user agents.",
  },
  "robots-txt-unavailable": {
    severity: "warning",
    category: "ai_access",
    scope: "site",
    title: "robots.txt could not be read",
    explanation:
      'robots.txt answered with an error or did not answer, so we could not tell which crawlers are allowed. Google treats a server error on robots.txt as "crawl nothing" for a while. Crawler access in this report is unverified.',
    howToFix:
      "Make `/robots.txt` return 200 with your rules, or 404 if you have none. Then run the audit again.",
  },
  "robots-txt-malformed": {
    severity: "warning",
    category: "ai_access",
    scope: "site",
    title: "robots.txt has no valid rules",
    explanation:
      "robots.txt returned content with no recognisable directives (often an HTML page served at /robots.txt). Crawlers treat it as allowing everything, and crawler access in this report is unverified.",
    howToFix:
      "Serve a plain-text robots.txt with `User-agent` groups and `Allow`/`Disallow` lines, or return 404 if you have no rules.",
  },
  "llms-txt-missing": {
    severity: "info",
    category: "ai_access",
    scope: "site",
    title: "No llms.txt file",
    explanation:
      "The site has no `/llms.txt`. It is an optional, emerging convention that gives AI tools a short guide to your most useful pages; no answer engine is known to require it.",
    howToFix:
      "Optionally add a Markdown file at `/llms.txt` starting with `# Your site name`, a one-line summary, and links to your key pages.",
  },
  "llms-txt-invalid": {
    severity: "warning",
    category: "ai_access",
    scope: "site",
    title: "llms.txt is not valid Markdown",
    explanation:
      "`/llms.txt` exists but is served as HTML or does not start with a `# ` title line, so tools that read it may ignore it.",
    howToFix:
      "Serve `/llms.txt` as `text/plain` or `text/markdown` and start it with a single `# Title` line.",
  },
  "structured-data-invalid": {
    severity: "warning",
    category: "structured_data",
    scope: "page",
    title: "Structured data cannot be parsed",
    explanation:
      'A `<script type="application/ld+json">` block on this page is not valid JSON, so search engines and AI tools ignore it.',
    howToFix:
      "Fix the JSON syntax (quotes, commas, brackets) and test the page in a structured-data validator.",
  },
  "structured-data-missing-type": {
    severity: "warning",
    category: "structured_data",
    scope: "page",
    title: "Structured data has no @type",
    explanation:
      "A JSON-LD object on this page has no `@type`, so nothing can tell what it describes.",
    howToFix:
      "Add the schema.org `@type` (for example `Organization`, `Product` or `Article`) to each JSON-LD object.",
  },
  "structured-data-missing-required": {
    severity: "warning",
    category: "structured_data",
    scope: "page",
    title: "Structured data is missing key properties",
    explanation:
      "A JSON-LD object lacks properties Google documents as required for its type (listed below). Incomplete markup is usually ignored.",
    howToFix:
      "Add the missing properties with values that match what the page shows. Markup helps machines read the page; it does not guarantee rich results or AI citations.",
  },
  "structured-data-not-visible": {
    severity: "warning",
    category: "structured_data",
    scope: "page",
    title: "Structured data claims aren't on the page",
    explanation:
      "Some JSON-LD values (names, descriptions, prices, ratings or SKUs, listed below) do not appear in the page's visible text. Search engines may treat markup that contradicts the page as spam.",
    howToFix:
      "Make the markup match the visible content, or show the same facts on the page.",
  },
  "no-structured-data": {
    severity: "info",
    category: "structured_data",
    scope: "page",
    title: "No structured data",
    explanation:
      "This indexable page has no JSON-LD. Structured data helps search engines and AI tools identify your organisation, products and articles.",
    howToFix:
      "Add JSON-LD for what the page is about (for example `Organization` on the homepage, `Product` on product pages, `Article` on posts).",
  },
  "missing-og-tags": {
    severity: "info",
    category: "social",
    scope: "page",
    title: "Open Graph tags missing",
    explanation:
      "The page lacks one or more of `og:title`, `og:description` and `og:image` (listed below). Social networks, chat apps and some AI tools use them for link previews.",
    howToFix:
      'Add the missing `<meta property="og:…">` tags with a page-specific title, description and an absolute image URL.',
  },
  "hreflang-invalid": {
    severity: "warning",
    category: "international",
    scope: "page",
    title: "Invalid hreflang annotation",
    explanation:
      "An `hreflang` value is not a valid language(-region) code or `x-default`, or its `href` is not an absolute http(s) URL (listed below). Search engines ignore invalid annotations.",
    howToFix:
      "Use ISO 639-1 language codes with optional ISO 3166-1 region codes (for example `en-GB`) and absolute URLs.",
  },
  "hreflang-missing-self": {
    severity: "info",
    category: "international",
    scope: "page",
    title: "hreflang has no self-reference",
    explanation:
      "The page lists language alternates but none points to the page itself. Google expects each page in a set to include itself.",
    howToFix:
      "Add an `hreflang` link for this page's own language pointing at its own URL.",
  },
  "hreflang-no-return-link": {
    severity: "warning",
    category: "international",
    scope: "page",
    title: "hreflang alternate does not link back",
    explanation:
      "This page lists an alternate that we crawled, but that alternate does not list this page back. Search engines ignore one-way hreflang pairs.",
    howToFix:
      "Add the reciprocal `hreflang` link on the alternate page (listed below).",
  },
  "snippet-restricted": {
    severity: "warning",
    category: "indexability",
    scope: "page",
    title: "Snippets are restricted",
    explanation:
      "The page limits what can be quoted (`nosnippet`, `max-snippet:0` or `data-nosnippet`, listed below). Search results and AI answers may show no text from it.",
    howToFix:
      "Remove the restriction from pages you want quoted, or narrow `data-nosnippet` to the exact text that must not be shown.",
  },
} as const satisfies Record<string, AuditIssueDescriptor>;

export type AuditIssueType = keyof typeof AUDIT_ISSUE_TYPES;

export const ISSUE_SEVERITY_ORDER: Record<IssueSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export const ISSUE_CATEGORY_LABELS: Record<IssueCategory, string> = {
  crawl: "Crawlability",
  links: "Links & Redirects",
  content: "Content",
  indexability: "Indexability",
  performance: "Performance",
  ai_access: "AI Crawler Access",
  structured_data: "Structured Data",
  social: "Social & Open Graph",
  international: "International & Hreflang",
};

const issueRegistry: Record<string, AuditIssueDescriptor> = AUDIT_ISSUE_TYPES;

export function getIssueDescriptor(
  issueType: string,
): AuditIssueDescriptor | null {
  return issueRegistry[issueType] ?? null;
}
