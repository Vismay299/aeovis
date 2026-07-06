import { NextResponse } from "next/server";
import { generateContent } from "@/lib/gemini";

export async function POST(request) {
  try {
    const { gaps, brand } = await request.json();

    if (!gaps || gaps.length === 0) {
      return NextResponse.json({ recommendations: [] });
    }

    const promptText = `You are an SEO and AEO (Answer Engine Optimization) expert.
I have identified ${gaps.length} high-value prompts where the brand "${brand}" is currently NOT mentioned by the AI, but competitors might be.

Here are the gaps (prompts):
${gaps.map((g, i) => `${i + 1}. Prompt: "${g.prompt}" | Volume: ${g.volume} | Competitors present: ${(g.competitors_found || []).join(", ")}`).join("\n")}

For EACH of these prompts, provide a 1-sentence strategic recommendation on how "${brand}" can capture this query (e.g., "Publish a comparison guide against competitor X" or "Create a dedicated landing page addressing this high-intent query").

Return a JSON array of strings in the exact same order as the prompts.
Only return valid JSON.`;

    const stats = { tokens: 0 };
    const { text: jsonStr } = await generateContent(promptText, { jsonMode: true, temperature: 0.2, stats, timeout: 20000 });
    console.log(`[opportunities] generated in ${stats.tokens} tokens`);
    const cleanStr = jsonStr.replace(/```json\n?|\n?```/g, "").trim();
    const result = JSON.parse(cleanStr);

    let recommendations = [];
    if (Array.isArray(result)) {
      recommendations = result;
    } else if (result.recommendations && Array.isArray(result.recommendations)) {
      recommendations = result.recommendations;
    }

    return NextResponse.json({ recommendations });
  } catch (error) {
    console.error("Opportunities LLM error:", error);
    return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 });
  }
}
