import { NextResponse } from "next/server";
import {
  listKnowledgeBlocks,
  insertKnowledgeBlock,
  reorderKnowledgeBlocks,
  KNOWLEDGE_TYPES,
} from "@/server/db/knowledge";
import { scrapeSite } from "@/server/firecrawl";
import { SsrfBlockedError, isPolicyRefusal, normalizeTargetUrl } from "@/server/ssrfGuard";

/**
 * What we tell a caller whose URL the SSRF guard refused.
 *
 * Fixed string, and never the guard's own message: that message names the
 * address the host resolved to, which would turn this endpoint into a DNS
 * oracle — "did example.internal resolve, and to what?" — for anyone with a
 * session. The reason code goes to the log instead.
 */
const REFUSED_URL_MESSAGE =
  "That URL cannot be fetched. Provide a publicly reachable http(s) address.";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/knowledge?brand= — the brand's knowledge blocks in drag order. */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const brand = (searchParams.get("brand") || "").trim();
    if (!brand) {
      return NextResponse.json({ detail: "brand query param is required." }, { status: 400 });
    }
    const blocks = await listKnowledgeBlocks(brand);
    return NextResponse.json({ blocks, types: KNOWLEDGE_TYPES }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Knowledge GET error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * POST /api/knowledge — create a block. For type "url", the content is
 * fetched via Firecrawl server-side so the stored block is the extracted
 * text, not a bare link.
 */
export async function POST(request) {
  try {
    const payload = await request.json();
    const brand = (payload.brand || "").trim();
    if (!brand) return NextResponse.json({ detail: "brand is required." }, { status: 400 });

    const type = KNOWLEDGE_TYPES.includes(payload.type) ? payload.type : "snippet";
    let content = String(payload.content || "").trim();
    let sourceUrl = payload.source_url ? String(payload.source_url).trim() : null;
    let title = String(payload.title || "").trim();

    if (type === "url") {
      const raw = sourceUrl || content;
      if (!raw) {
        return NextResponse.json({ detail: "A URL is required for a url block." }, { status: 400 });
      }
      // R3.7.4: the scheme test here used to be `url.startsWith("http")`, so
      // "gopher://127.0.0.1:6379/_INFO" fell to the else branch and was glued
      // into "https://gopher://127.0.0.1:6379/_INFO" — a URL whose host is the
      // single label "gopher", which we then sent to the resolver before
      // answering 422. A scheme we do not speak is the caller's input being
      // wrong; decide it here, with the same parser the guard uses, before any
      // DNS query leaves the box.
      let normalized;
      try {
        normalized = normalizeTargetUrl(raw);
      } catch (error) {
        if (!(error instanceof SsrfBlockedError)) throw error;
        console.warn(`[ssrf-guard] rejected knowledge source_url (${error.code}): ${error.message}`);
        return NextResponse.json({ detail: REFUSED_URL_MESSAGE }, { status: 400 });
      }
      sourceUrl = normalized.toString();
      // R3.7.2: this used to string-compare the result against the literal
      // "No website content available." to decide whether the scrape worked.
      // The scrape now reports its own state, and the 422 names WHICH failure
      // it was instead of collapsing every one of them into one sentence.
      const scraped = await scrapeSite(sourceUrl);
      if (!scraped.content) {
        console.warn(
          `[knowledge] scrape of ${sourceUrl} is ${scraped.state} (${scraped.state_reason})` +
            `${scraped.detail ? `: ${scraped.detail}` : ""}`
        );
        return NextResponse.json(
          {
            detail: "Could not extract content from that URL.",
            scrape_state: scraped.state,
            scrape_state_reason: scraped.state_reason,
          },
          { status: 422 }
        );
      }
      if (scraped.degraded) {
        // Stored, but not as a clean vendor extraction — a crude HTML strip is
        // what the operator is about to edit, and the log says so.
        console.warn(
          `[knowledge] scrape of ${sourceUrl} is degraded (${scraped.state_reason}) — ` +
            `${scraped.content_chars} chars from ${scraped.source}`
        );
      }
      content = scraped.content;
      if (!title) {
        try {
          title = new URL(sourceUrl).hostname.replace(/^www\./, "") + new URL(sourceUrl).pathname;
        } catch {
          title = sourceUrl;
        }
      }
    }

    if (!content) {
      return NextResponse.json({ detail: "content is required." }, { status: 400 });
    }

    const block = await insertKnowledgeBlock(brand, {
      type,
      title: title || "Untitled",
      content,
      source_url: sourceUrl,
    });
    return NextResponse.json({ block }, { status: 201 });
  } catch (error) {
    // R3.7.4: scrapeSite throws SsrfBlockedError when the SSRF guard refuses
    // source_url. That is the caller's input being wrong, not this server being
    // broken, so it is a 400 — a 500 says "we failed", pages whoever owns the
    // alert, and hides a probe in the noise of real outages. Only POLICY
    // refusals land here: a typo or an NXDOMAIN is an "unusable target", for
    // which scrapeSite returns state=unavailable/unusable_target and the 422
    // above already fires.
    if (isPolicyRefusal(error)) {
      console.error(`[ssrf-guard] refused knowledge source_url (${error.code}): ${error.message}`);
      return NextResponse.json({ detail: REFUSED_URL_MESSAGE }, { status: 400 });
    }
    console.error("Knowledge POST error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

/** PATCH /api/knowledge — { brand, order: [ids] } persists a new drag order. */
export async function PATCH(request) {
  try {
    const { brand, order } = await request.json();
    if (!brand || !Array.isArray(order)) {
      return NextResponse.json({ detail: "brand and order[] are required." }, { status: 400 });
    }
    const blocks = await reorderKnowledgeBlocks(brand.trim(), order);
    return NextResponse.json({ blocks });
  } catch (error) {
    console.error("Knowledge PATCH error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
