/**
 * Perplexity response extractor — pure function (R1.3.2).
 *
 * Extracts answer text and sources (url/domain/title) from Perplexity API
 * response shapes. Parse failure yields parse_error, never empty-answered.
 *
 * This module is SIDE-EFFECT FREE: it takes raw JSON, returns structured output.
 * No fetch, no env, no stats — just parsing.
 */

/**
 * Extract the answer text from a Perplexity /chat/completions response.
 *
 * @param {object} json the parsed JSON body of the /chat/completions response
 * @returns {{ text: string, outcome: "answered" | "parse_error", error?: string }}
 */
export function extractPerplexityAnswer(json) {
  if (!json || typeof json !== "object") {
    return { text: "", outcome: "parse_error", error: "response is not an object" };
  }

  try {
    const choices = json.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return { text: "", outcome: "parse_error", error: "no choices array in response" };
    }

    const first = choices[0];
    if (!first || typeof first !== "object") {
      return { text: "", outcome: "parse_error", error: "first choice is not an object" };
    }

    const message = first.message;
    if (!message || typeof message !== "object") {
      return { text: "", outcome: "parse_error", error: "no message in first choice" };
    }

    const content = message.content;
    if (typeof content !== "string") {
      return { text: "", outcome: "parse_error", error: "content is not a string" };
    }

    const text = content.trim();
    if (!text) {
      // An empty string from a valid response shape is still parseable —
      // it is a legitimate empty answer, not a parse failure.
      return { text: "", outcome: "answered" };
    }

    return { text, outcome: "answered" };
  } catch (e) {
    return { text: "", outcome: "parse_error", error: e?.message || "unexpected parse error" };
  }
}

/**
 * Extract sources from a Perplexity /search response.
 *
 * Each source carries url, title, and a derived domain. Duplicate URLs are
 * deduplicated.
 *
 * @param {object} json the parsed JSON body of the /search response
 * @returns {{ sources: Array<{url: string, domain: string, title: string}>, outcome: "answered" | "parse_error", error?: string }}
 */
export function extractPerplexitySources(json) {
  if (!json || typeof json !== "object") {
    return { sources: [], outcome: "parse_error", error: "response is not an object" };
  }

  try {
    const results = json.results;
    if (!Array.isArray(results)) {
      return { sources: [], outcome: "parse_error", error: "no results array in response" };
    }

    const seen = new Set();
    const sources = [];

    for (const item of results) {
      if (!item || typeof item !== "object") continue;

      const url = String(item.url || "").trim();
      if (!url) continue;
      if (seen.has(url)) continue;
      seen.add(url);

      const domain = extractDomain(url);
      const title = String(item.title || "").trim();

      sources.push({ url, domain, title });
    }

    return { sources, outcome: "answered" };
  } catch (e) {
    return { sources: [], outcome: "parse_error", error: e?.message || "unexpected parse error" };
  }
}

/**
 * Extract the answer text and sources from a combined Perplexity probe result.
 *
 * Accepts the raw JSON from both legs (answer + search) and returns a unified
 * extraction. If either leg fails to parse, the parse_error is reported but
 * the other leg's data is still returned (partial extraction is better than
 * throwing away what we got).
 *
 * @param {{ answerJson?: object, searchJson?: object }} raw
 * @returns {{
 *   text: string,
 *   sources: Array<{url: string, domain: string, title: string}>,
 *   outcome: "answered" | "parse_error",
 *   errors: string[]
 * }}
 */
export function extractPerplexity({ answerJson, searchJson } = {}) {
  const errors = [];
  let worstOutcome = "answered";

  // Neither leg provided: we have nothing to parse, which is not "answered".
  if (answerJson === undefined && searchJson === undefined) {
    return { text: "", sources: [], outcome: "parse_error", errors: ["no input provided"] };
  }

  const answer = answerJson !== undefined ? extractPerplexityAnswer(answerJson) : null;
  if (answer?.outcome === "parse_error") {
    worstOutcome = "parse_error";
    if (answer.error) errors.push(`answer: ${answer.error}`);
  }

  const sources = searchJson !== undefined ? extractPerplexitySources(searchJson) : null;
  if (sources?.outcome === "parse_error") {
    worstOutcome = "parse_error";
    if (sources.error) errors.push(`search: ${sources.error}`);
  }

  return {
    text: answer?.text ?? "",
    sources: sources?.sources ?? [],
    outcome: worstOutcome,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a domain from a URL string. Returns "" for unparseable URLs.
 *
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
