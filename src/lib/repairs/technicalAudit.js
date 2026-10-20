import { safeFetch } from "../ssrfGuard.js";
import { parseRobotsTxt, evaluateBot } from "../crawlers/robots.js";
import { AI_BOTS } from "../crawlers/bots.js";
import { canonicalPage, meaningfulText, artifactHash } from "./workflow.js";
export async function boundedResponseText(response, maxBytes = 2_000_000) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes)
      throw Error("Response exceeds the capture limit");
    return text;
  }
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw Error("Response exceeds the capture limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => console.warn("[technical-audit] source stream cleanup failed"));
  }
}
function attrs(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(
      (m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]],
    ),
  );
}
export function inspectPage({
  url,
  finalUrl = url,
  html,
  status = 200,
  headers = {},
  robots = null,
  robotsState = "unknown",
  trace = [],
  discovery = "approved_input",
  capturedAt = new Date().toISOString(),
}) {
  const markup=html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ");
  const metadata = [...markup.matchAll(/<meta\b[^>]*>/gi)].map((m) =>
    attrs(m[0]),
  );
  const directives = metadata
    .filter((m) => /^(robots|googlebot|bingbot)$/i.test(m.name || ""))
    .map((m) => ({ source: `meta:${m.name}`, value: m.content || "" }));
  const xrobots = headers["x-robots-tag"];
  if (xrobots) directives.push({ source: "x-robots-tag", value: xrobots });
  const restrictive = directives.filter((d) =>
    /\b(noindex|none|nosnippet|max-snippet\s*:\s*0)\b/i.test(d.value),
  );
  const canonicalTag = [...markup.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => attrs(m[0]))
    .find((a) => a.rel?.toLowerCase().split(/\s+/).includes("canonical"));
  let canonical = null, canonicalState = canonicalTag?.href ? "declared" : "absent";
  try {
    if (canonicalTag?.href)
      canonical = canonicalPage(new URL(canonicalTag.href, finalUrl).href);
  } catch { canonicalState="invalid"; }
  const sourceText = meaningfulText(markup);
  const structured = [];
  for (const m of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const doc = JSON.parse(m[1]);
      const claims = [];
      function walk(v, path = "$") {
        if (!v || typeof v !== "object") return;
        for (const [k, x] of Object.entries(v)) {
          if (
            ["name", "description", "price", "ratingValue", "sku"].includes(
              k,
            ) &&
            ["string", "number"].includes(typeof x)
          )
            claims.push({
              path: `${path}.${k}`,
              value: x,
              visible_in_source: sourceText
                .toLowerCase()
                .includes(String(x).toLowerCase()),
            });
          else if (x && typeof x === "object") walk(x, `${path}.${k}`);
        }
      }
      walk(doc);
      structured.push({
        parse_state: "valid_json",
        type: doc["@type"] || null,
        claims,
      });
    } catch {
      structured.push({ parse_state: "invalid_json", claims: [] });
    }
  }
  const robotsRules = AI_BOTS.map((bot) => ({
    ...bot,
    ...(robotsState === "found" || robotsState === "missing"
      ? evaluateBot(robots, bot.name, new URL(finalUrl).pathname)
      : {
          status: "unknown",
          reason: "Robots response unavailable or malformed",
        }),
  }));
  const issues = [];
  const add = (code, severity, evidence, action) =>
    issues.push({
      code,
      severity,
      evidence,
      action,
      target_url: finalUrl,
      owner: "Website owner",
      confidence: "observed",
      engine_relevance: "Search and answer discovery",
      retest:
        "Fetch the same URL after the change and compare directives/content; confirm indexing separately",
    });
  if (status !== 200)
    add(
      status === 403 ? "access_denied" : "http_status",
      "high",
      `HTTP ${status}`,
      "Resolve the observed access/status issue",
    );
  for (const d of restrictive)
    add(
      "restrictive_directive",
      "high",
      d,
      "Review the intended indexing and snippet policy",
    );
  if (/\bdata-nosnippet(?:[\s=>])/i.test(html))
    add(
      "data_nosnippet",
      "medium",
      "data-nosnippet present",
      "Review the exact excluded content",
    );
  if (canonical && canonical !== canonicalPage(finalUrl))
    add(
      "canonical_other_url",
      "medium",
      canonical,
      "Verify the declared canonical and page ownership",
    );
  if (sourceText.length < 150)
    add(
      "insufficient_source_text",
      "medium",
      `${sourceText.length} source characters`,
      "Inspect source and rendered content; rendering has not been measured",
    );
  if (
    structured.some(
      (s) =>
        s.parse_state === "invalid_json" ||
        s.claims.some((c) => !c.visible_in_source),
    )
  )
    add(
      "structured_data_requires_review",
      "medium",
      structured,
      "Resolve malformed or source-unverified structured claims; markup does not guarantee ranking",
    );
  return {
    url: canonicalPage(url),
    final_url: canonicalPage(finalUrl),
    status,
    redirects: trace,
    discovery,
    canonical,
    canonical_state:canonicalState,
    canonical_selected_by_google: null,
    directives,
    source_text_chars: sourceText.length,
    source_sha256: artifactHash(html),
    captured_at: capturedAt,
    structured_data: structured,
    robots_state: robotsState,
    robots: robotsRules,
    rendered_content: { state: "unmeasured" },
    indexing: { state: "unknown" },
    verified_crawler_fetch: { state: "unobserved" },
    ai_inclusion_control: {
      state: "unverified",
      reason: "Authorized property settings have not been imported",
    },
    issues,
  };
}
export async function auditOwnedPages({
  website,
  approvedUrls = [],
  maxRequests = 6,
  fetchImpl = globalThis.fetch,
  lookup,
}) {
  const start = canonicalPage(website),
    host = new URL(start).hostname;
  if (maxRequests < 3 || maxRequests > 8)
    throw Error("Audit request ceiling must be 3–8");
  let requests = 0;
  const inScope = (value) => new URL(value).hostname === host;
  const read = async (url) => {
    const trace = [];
    const response = await safeFetch(
      url,
      {
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "PerceevTechnicalAudit/1.0" },
      },
      {
        lookup,
        fetchImpl: async (target, init) => {
          if (!inScope(target))
            throw Error("Redirect left the owned audit scope");
          if (requests >= maxRequests)
            throw Error("Audit request ceiling reached");
          requests++;
          const response = await fetchImpl(target, init);
          trace.push({
            url: String(target),
            status: response.status,
            location: response.headers.get("location"),
          });
          return response;
        },
      },
    );
    return { response, trace, text: await boundedResponseText(response) };
  };
  let robotsText = "",
    robotsState = "unknown",
    sitemapText = "";
  const failures = [];
  try {
    const r = await read(new URL("/robots.txt", start).href);
    robotsText = r.text;
    robotsState =
      r.response.status === 404
        ? "missing"
        : r.response.status === 200
          ? "found"
          : "unavailable";
  } catch {
    failures.push({ resource: "robots", reason: "unavailable" });
  }
  const robots = parseRobotsTxt(robotsText);
  if (robotsState === "found" && robots.malformed) robotsState = "malformed";
  try {
    const candidate =
      robots.sitemaps.find(inScope) || new URL("/sitemap.xml", start).href;
    const s = await read(candidate);
    if (s.response.status === 200) sitemapText = s.text;
  } catch {
    failures.push({ resource: "sitemap", reason: "unavailable" });
  }
  const discovered = new Map([
    [start, "homepage"],
    ...approvedUrls.map((value) => [canonicalPage(value), "approved_input"]),
  ]);
  for (const m of sitemapText.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
    try {
      const target = canonicalPage(m[1]);
      if (inScope(target) && !discovered.has(target))
        discovered.set(target, "sitemap");
    } catch { failures.push({resource:"sitemap_entry",reason:"invalid_or_unsupported_url"}); }
  }
  const pages = [];
  for (const [url, discovery] of discovered) {
    if (requests >= maxRequests) break;
    if (!inScope(url)) throw Error("Approved URL is outside the owned website");
    try {
      const r = await read(url);
      const final = r.trace.at(-1)?.url || url;
      pages.push(
        inspectPage({
          url,
          finalUrl: final,
          html: r.text,
          status: r.response.status,
          headers: Object.fromEntries(r.response.headers),
          trace: r.trace,
          discovery,
          robots,
          robotsState,
        }),
      );
      for (const m of r.text.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
        try {
          const next = canonicalPage(new URL(m[1], final).href);
          if (inScope(next) && !discovered.has(next))
            discovered.set(next, "internal_link");
        } catch { if(failures.length<100)failures.push({resource:"internal_link",reason:"unsupported_or_invalid_url"}); }
      }
    } catch {
      failures.push({ url, reason: "fetch_or_scope_failure" });
    }
  }
  return {
    schema_version: "technical-evidence-v1",
    scope: {
      website: start,
      max_requests: maxRequests,
      requests,
      whole_site_audit: false,
    },
    pages,
    failures,
    captured_at: new Date().toISOString(),
    interpretation:
      "Observed fetch/directive facts only. Indexing, rendered accessibility, crawler visits and inclusion settings require separate evidence.",
  };
}
