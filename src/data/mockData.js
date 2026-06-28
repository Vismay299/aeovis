export function buildMockResult(brand, website) {
  const name = brand || "Acme Analytics";
  const site = website || "acme.com";
  return {
    brand: name,
    website: site,
    visibilityScore: 64,
    promptsAnalyzed: 24,
    competitorsFound: 7,
    scanTimestamp: new Date().toISOString(),
    summary:
      `${name} appears in roughly two-thirds of AI answers for its core category, ` +
      `but is frequently outranked on high-intent comparison prompts. Competitors dominate ` +
      `"best tool for…" and pricing-related queries where ${name} is absent. Closing these gaps ` +
      `could meaningfully lift answer-engine presence.`,
    topPrompts: [
      { prompt: `What is the best ${name} alternative?`, rank: 3, volume: "High" },
      { prompt: `Top tools for AI visibility tracking`, rank: 2, volume: "High" },
      { prompt: `How does ${name} compare to competitors?`, rank: 1, volume: "Medium" },
      { prompt: `Affordable analytics platforms for startups`, rank: 5, volume: "Medium" },
      { prompt: `Best software for marketing teams 2026`, rank: 6, volume: "High" },
      { prompt: `${name} pricing and plans`, rank: 2, volume: "Low" },
      { prompt: `Enterprise-grade brand monitoring tools`, rank: "—", volume: "Medium" },
      { prompt: `Which platforms track AI search rankings?`, rank: 4, volume: "Medium" },
    ],
    competitors: [
      { name: "Brightwave", mentions: 18, prompts: 12, userAbsent: true },
      { name: "NorthPeak", mentions: 14, prompts: 9, userAbsent: true },
      { name: "Lumen IQ", mentions: 11, prompts: 7, userAbsent: false },
      { name: "Vantage", mentions: 9, prompts: 6, userAbsent: true },
      { name: "Coreset", mentions: 6, prompts: 4, userAbsent: false },
      { name: "Pulse Metrics", mentions: 5, prompts: 3, userAbsent: true },
      { name: "Echelon", mentions: 3, prompts: 2, userAbsent: false },
    ],
  };
}

export const SAMPLE_RESULT = buildMockResult("Brightwave", "brightwave.io");
