import { NextResponse } from "next/server";
import {
  listKnowledgeBlocks,
  insertKnowledgeBlock,
  reorderKnowledgeBlocks,
  KNOWLEDGE_TYPES,
} from "@/lib/db/knowledge";
import { scrapeForSummary } from "@/lib/firecrawl";

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
      const url = sourceUrl || content;
      if (!url || !/^https?:\/\//i.test(url.startsWith("http") ? url : `https://${url}`)) {
        return NextResponse.json({ detail: "A URL is required for a url block." }, { status: 400 });
      }
      sourceUrl = url.startsWith("http") ? url : `https://${url}`;
      const scraped = await scrapeForSummary(sourceUrl);
      if (!scraped || scraped === "No website content available.") {
        return NextResponse.json(
          { detail: "Could not extract content from that URL." },
          { status: 422 }
        );
      }
      content = scraped;
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
