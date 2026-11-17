// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/rendered-page.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { MAX_HTML_BYTES, readTextUpTo, truncateToBytes } from "./htmlResponse.ts";
import { classifyFetch } from "./classifyFetch.ts";
import { isCrawlableUrl } from "./urlPolicy.ts";
import { normalizeUrl } from "./urlUtils.ts";

export interface RenderUsage {
  attempts: number;
  billed: number;
}

export interface RenderPageOptions {
  apiKey: string;
  usage: RenderUsage;
  fetchImpl?: typeof fetch;
  auditId?: string;
  endpoint?: string;
}

export type RenderedPage = { html: string; status: number | null };

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";
const FIRECRAWL_TIMEOUT_MS = 35_000;
const FIRECRAWL_BODY_TIMEOUT_MS = 30_000;
const FIRECRAWL_WAIT_MS = 1000;
// JSON escaping can expand HTML bytes up to sixfold; bound transport before parse.
const MAX_RESPONSE_BYTES = 8 * MAX_HTML_BYTES;

const firecrawlResponseSchema = z.looseObject({
  success: z.literal(true),
  data: z.looseObject({
    rawHtml: z.string(),
    metadata: z.looseObject({
      statusCode: z.number().int().optional(),
      url: z.string().optional(),
      sourceURL: z.string().optional(),
    }),
  }),
});

/**
 * The rendered HTML to analyze: the same first 1 MiB the direct crawl keeps.
 */
function usableHtml(url: string, finalUrl: string, html: string): string {
  if (normalizeUrl(finalUrl, url) !== normalizeUrl(url, url)) {
    throw new Error("Rendering returned a different URL");
  }
  if (!html.trim()) throw new Error("Rendered HTML is empty");
  return truncateToBytes(html, MAX_HTML_BYTES);
}

function isTimeoutError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /timed out|timeout|aborted/i.test(message)
  );
}

/**
 * Renders one URL through Firecrawl `rawHtml`. Billed scrapes never retry:
 * callers run this inside a `billed: true, retries: 0` step and abandon the
 * chunk on failure instead of re-rendering.
 */
export async function renderPage(url: string, options: RenderPageOptions): Promise<RenderedPage> {
  const { apiKey, usage, fetchImpl, auditId, endpoint } = options;
  if (!isCrawlableUrl(url)) {
    throw new Error("Invalid rendering target");
  }
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error("Invalid rendering target");
  } catch (err) {
    if (err instanceof Error && err.message === "Invalid rendering target") throw err;
    throw new Error("Invalid rendering target");
  }
  if (!apiKey) throw new Error("Rendering is not configured");

  const impl = fetchImpl ?? fetch;
  usage.attempts += 1;

  let response: Response;
  try {
    response = await impl(endpoint ?? FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["rawHtml"],
        onlyMainContent: false,
        waitFor: FIRECRAWL_WAIT_MS,
        timeout: FIRECRAWL_BODY_TIMEOUT_MS,
      }),
      signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
    });
  } catch (err) {
    // The request left the process; outcome unknown so count it as billed
    // (ambiguous) and never retry. Nothing raw is logged.
    if (isTimeoutError(err)) {
      usage.billed += 1;
      console.info("[audit] render", { auditId: auditId ?? null, outcome: "timeout", httpStatus: null });
    } else {
      console.info("[audit] render", { auditId: auditId ?? null, outcome: "error", httpStatus: null });
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  const httpStatus = response.status;
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
    // 4xx (except ambiguous 408/429) is rejected before billing.
    console.info("[audit] render", { auditId: auditId ?? null, outcome: "rejected", httpStatus });
    throw new Error(`Rendering failed with status ${httpStatus}`);
  }

  let rawHtml: string;
  let metadataUrl: string | undefined;
  let metadataStatus: number | null = null;
  try {
    const text = await readTextUpTo(response, MAX_RESPONSE_BYTES);
    const json = JSON.parse(text);
    const parsed = firecrawlResponseSchema.parse(json);
    rawHtml = parsed.data.rawHtml;
    metadataUrl =
      parsed.data.metadata.url ?? (parsed.data.metadata as { sourceURL?: string }).sourceURL;
    metadataStatus =
      typeof parsed.data.metadata.statusCode === "number"
        ? parsed.data.metadata.statusCode
        : null;
  } catch (err) {
    if (response.status === 200) {
      // A 200 that cannot be parsed still consumed provider work.
      usage.billed += 1;
    }
    console.info("[audit] render", { auditId: auditId ?? null, outcome: "error", httpStatus });
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (!response.ok) {
    console.info("[audit] render", { auditId: auditId ?? null, outcome: "error", httpStatus });
    throw new Error(`Rendering failed with status ${httpStatus}`);
  }

  // HTTP 200 + success:true is a billed scrape, even if the HTML is unusable.
  usage.billed += 1;

  const html = usableHtml(url, metadataUrl ?? url, rawHtml);
  const status = metadataStatus;
  if (status !== null && status >= 400) {
    console.info("[audit] render", { auditId: auditId ?? null, outcome: "error", httpStatus });
    throw new Error(`Rendered page has status ${status}`);
  }
  if (classifyFetch(status ?? 200, false, html.slice(0, 4_000)) !== "ok") {
    console.info("[audit] render", { auditId: auditId ?? null, outcome: "error", httpStatus });
    throw new Error("Rendered page is not usable");
  }

  console.info("[audit] render", { auditId: auditId ?? null, outcome: "ok", httpStatus });
  return { html, status };
}
