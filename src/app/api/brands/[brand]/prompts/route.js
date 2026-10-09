import { NextResponse } from "next/server";
import { getPromptsForBrand, upsertPrompts } from "@/lib/db/prompts";
import { normalizeTopic } from "@/lib/scoring/topics";

export async function GET(request, { params }) {
  params = await params;
  try {
    // The path param is the canonical pool key (domain-first, resolveBrandKey).
    const { brand } = params;
    const decodedBrand = decodeURIComponent(brand);
    const { searchParams } = new URL(request.url);
    const includeDisabled = searchParams.get("includeDisabled") === "true";
    let prompts = await getPromptsForBrand(decodedBrand, includeDisabled);

    // Pre-migration pools live under the typed brand name until the next scan
    // re-homes them. Fall back for reads so the Queries tab isn't empty.
    const legacyBrand = searchParams.get("legacyBrand");
    if ((!prompts || prompts.length === 0) && legacyBrand && legacyBrand !== decodedBrand) {
      prompts = await getPromptsForBrand(legacyBrand, includeDisabled);
    }

    return NextResponse.json({ prompts });
  } catch (error) {
    console.error("Failed to get prompts:", error);
    return NextResponse.json({ error: "Failed to get prompts" }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  params = await params;
  try {
    const { brand } = params;
    const decodedBrand = decodeURIComponent(brand);
    const { text, intent_tier, topic, weight } = await request.json();

    if (!text) {
      return NextResponse.json({ error: "Prompt text is required" }, { status: 400 });
    }

    const newPrompt = {
      text,
      intent_tier: intent_tier || "exploratory",
      topic: normalizeTopic(topic || "General"),
      weight: weight ?? null,
      enabled: true
    };

    const { error } = await upsertPrompts(decodedBrand, [newPrompt]);
    if (error) {
      return NextResponse.json({ error: error.message || "Failed to save prompt" }, { status: 500 });
    }

    return NextResponse.json({ success: true, prompt: newPrompt });
  } catch (error) {
    console.error("Failed to add prompt:", error);
    return NextResponse.json({ error: "Failed to add prompt" }, { status: 500 });
  }
}
