/**
 * Static registry of known AI crawlers — P5 Crawlability (plan.md).
 *
 * Purpose taxonomy (`purpose`) is the single axis the rest of this feature
 * keys off of (filters, chips, "group" labels are all derived from it, never
 * stored redundantly on each bot):
 *
 *   - "training" — harvests pages to build/improve a model's weights or a
 *     licensed training corpus. Not an on-demand user action.
 *   - "search"   — indexes pages to ground a search or answer-engine product
 *     (classic search index, or an AI answer engine's retrieval index).
 *   - "agent"    — fetches a specific page on-demand, usually because an end
 *     user pasted/asked about that URL inside a chat/assistant product.
 *
 * This list is necessarily a curated snapshot (like the equivalent tables in
 * Peec AI, Originality.ai, or Cloudflare's AI Audit bot list) — operators add
 * and rename crawlers over time. Keep entries to bots with a real, documented
 * user-agent product token; do not invent tokens.
 *
 * Shape: { name, operator, platform, purpose }
 *   name     — the exact `User-agent` product token as it appears in the
 *              wild (case as commonly published; matching against robots.txt
 *              is case-insensitive regardless, see robots.js).
 *   operator — the company/org running the crawler.
 *   platform — the product surface the crawl feeds.
 *   purpose  — one of BOT_PURPOSES below.
 */

export const BOT_PURPOSES = ["training", "search", "agent"];

/** Human label + short blurb for each purpose — the UI's filter chips / "group" derivation. */
export const PURPOSE_META = {
  training: { label: "Training", description: "Harvests content to train or fine-tune a model." },
  search: { label: "Search", description: "Indexes content to ground a search or answer engine." },
  agent: { label: "Agent", description: "Fetches a specific page on-demand for a user's request." },
};

export const AI_BOTS = [
  // --- OpenAI ---------------------------------------------------------
  { name: "GPTBot", operator: "OpenAI", platform: "GPT model training", purpose: "training" },
  { name: "OAI-SearchBot", operator: "OpenAI", platform: "ChatGPT Search", purpose: "search" },
  { name: "ChatGPT-User", operator: "OpenAI", platform: "ChatGPT browsing & actions (on-demand)", purpose: "agent" },

  // --- Anthropic -------------------------------------------------------
  { name: "ClaudeBot", operator: "Anthropic", platform: "Claude model training", purpose: "training" },
  { name: "anthropic-ai", operator: "Anthropic", platform: "Claude model training (legacy crawler identity)", purpose: "training" },
  { name: "Claude-User", operator: "Anthropic", platform: "Claude on-demand fetch (user-referenced links)", purpose: "agent" },
  { name: "Claude-SearchBot", operator: "Anthropic", platform: "Claude search & answer grounding", purpose: "search" },
  { name: "Claude-Web", operator: "Anthropic", platform: "Legacy Claude crawler (predecessor to ClaudeBot)", purpose: "training" },

  // --- Google ------------------------------------------------------------
  { name: "Google-Extended", operator: "Google", platform: "Gemini & AI training (Search unaffected)", purpose: "training" },
  { name: "Googlebot", operator: "Google", platform: "Google Search & AI Overviews indexing", purpose: "search" },
  { name: "GoogleOther", operator: "Google", platform: "Internal Google research crawling", purpose: "training" },
  { name: "Google-CloudVertexBot", operator: "Google", platform: "Vertex AI Search / customer RAG agents", purpose: "agent" },

  // --- Perplexity ----------------------------------------------------
  { name: "PerplexityBot", operator: "Perplexity", platform: "Perplexity search index", purpose: "search" },
  { name: "Perplexity-User", operator: "Perplexity", platform: "Perplexity Assistant on-demand fetch", purpose: "agent" },

  // --- ByteDance -------------------------------------------------------
  { name: "Bytespider", operator: "ByteDance", platform: "Doubao & TikTok AI model training", purpose: "training" },

  // --- Common Crawl ------------------------------------------------------
  { name: "CCBot", operator: "Common Crawl Foundation", platform: "Common Crawl corpus (widely reused for LLM training)", purpose: "training" },

  // --- Amazon --------------------------------------------------------
  { name: "Amazonbot", operator: "Amazon", platform: "Alexa & Amazon AI training", purpose: "training" },

  // --- Apple -------------------------------------------------------------
  { name: "Applebot", operator: "Apple", platform: "Siri & Spotlight Search indexing", purpose: "search" },
  { name: "Applebot-Extended", operator: "Apple", platform: "Apple Intelligence model training", purpose: "training" },

  // --- Meta ------------------------------------------------------------
  { name: "Meta-ExternalAgent", operator: "Meta", platform: "Meta AI training & search grounding", purpose: "training" },
  { name: "FacebookBot", operator: "Meta", platform: "Meta language-model training", purpose: "training" },
  { name: "meta-externalfetcher", operator: "Meta", platform: "Meta AI on-demand link fetch", purpose: "agent" },

  // --- Cohere --------------------------------------------------------
  { name: "cohere-ai", operator: "Cohere", platform: "Cohere model training", purpose: "training" },
  { name: "cohere-training-data-crawler", operator: "Cohere", platform: "Cohere model training data collection", purpose: "training" },

  // --- Microsoft -----------------------------------------------------
  { name: "Bingbot", operator: "Microsoft", platform: "Bing Search & Copilot grounding", purpose: "search" },
  { name: "BingPreview", operator: "Microsoft", platform: "Bing preview card rendering", purpose: "search" },

  // --- DuckDuckGo ------------------------------------------------------
  { name: "DuckAssistBot", operator: "DuckDuckGo", platform: "DuckAssist AI answers", purpose: "search" },
  { name: "DuckDuckBot", operator: "DuckDuckGo", platform: "DuckDuckGo Search index", purpose: "search" },

  // --- You.com -------------------------------------------------------
  { name: "YouBot", operator: "You.com", platform: "You.com search & AI answers", purpose: "search" },

  // --- Diffbot -------------------------------------------------------
  { name: "Diffbot", operator: "Diffbot", platform: "Diffbot Knowledge Graph & AI training data", purpose: "training" },

  // --- Timpi -----------------------------------------------------------
  { name: "Timpibot", operator: "Timpi", platform: "Timpi decentralized search index", purpose: "search" },

  // --- ImageSift -----------------------------------------------------
  { name: "ImagesiftBot", operator: "ImageSift", platform: "Image dataset collection for AI/ML training", purpose: "training" },

  // --- Webz.io / Omgili ------------------------------------------------
  { name: "Omgilibot", operator: "Webz.io", platform: "Web data feed resold for AI training", purpose: "training" },
  { name: "Webzio-Extended", operator: "Webz.io", platform: "AI training data opt-out crawler", purpose: "training" },

  // --- Huawei ----------------------------------------------------------
  { name: "PetalBot", operator: "Huawei", platform: "Petal Search & Celia AI assistant", purpose: "search" },

  // --- Allen Institute for AI --------------------------------------------
  { name: "AI2Bot", operator: "Allen Institute for AI", platform: "Dolma dataset / OLMo model training", purpose: "training" },

  // --- Velen.io --------------------------------------------------------
  { name: "VelenPublicWebCrawler", operator: "Velen.io", platform: "AI training data marketplace", purpose: "training" },

  // --- ProRata.ai ------------------------------------------------------
  { name: "ProRataInc", operator: "ProRata.ai", platform: "Gist AI news app (licensed content attribution)", purpose: "training" },

  // --- iAsk.ai -----------------------------------------------------------
  { name: "iaskspider", operator: "iAsk.ai", platform: "iAsk AI search engine", purpose: "search" },

  // --- Andi Search -----------------------------------------------------
  { name: "Andibot", operator: "Andi Search", platform: "Andi AI search assistant", purpose: "search" },

  // --- Exa Labs ----------------------------------------------------------
  { name: "ExaBot", operator: "Exa Labs", platform: "Exa AI search API for AI agents", purpose: "agent" },

  // --- Kagi ------------------------------------------------------------
  { name: "Kagibot", operator: "Kagi", platform: "Kagi Search & Kagi Assistant", purpose: "search" },

  // --- Yandex ------------------------------------------------------------
  { name: "YandexBot", operator: "Yandex", platform: "Yandex Search & YandexGPT grounding", purpose: "search" },
];

/** Case-insensitive exact-name lookup. Returns undefined when not found. */
export function getBotByName(name) {
  const needle = String(name || "").trim().toLowerCase();
  if (!needle) return undefined;
  return AI_BOTS.find((b) => b.name.toLowerCase() === needle);
}

/** All bots for a given purpose ("training" | "search" | "agent"). */
export function getBotsByPurpose(purpose) {
  return AI_BOTS.filter((b) => b.purpose === purpose);
}

/** Unique, alphabetically sorted operator list — drives an "operator" filter if the UI wants one. */
export function getOperators() {
  return Array.from(new Set(AI_BOTS.map((b) => b.operator))).sort((a, b) => a.localeCompare(b));
}

/** Human label for a purpose value; unknown purposes pass through unchanged rather than throwing. */
export function purposeLabel(purpose) {
  return PURPOSE_META[purpose]?.label || purpose;
}
