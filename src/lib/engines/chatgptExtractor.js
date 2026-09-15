/**
 * ChatGPT response extractor — pure function (R1.4.2).
 *
 * Extracts answer text, citation chips, and inline links from the OpenAI
 * Responses API JSON shape. Parse failure yields parse_error, never
 * empty-answered.
 *
 * This module is SIDE-EFFECT FREE: it takes raw JSON, returns structured output.
 * No fetch, no env, no stats — just parsing.
 */

/**
 * Extract the answer text and citations from a ChatGPT Responses API response.
 *
 * The Responses API returns an `output` array of typed items. The assistant
 * message lives in items of type "message" with role "assistant", and its
 * content blocks of type "output_text" carry the text and annotations
 * (url_citation).
 *
 * @param {object} json the parsed JSON body of the /v1/responses response
 * @returns {{
 *   text: string,
 *   citations: Array<{url: string, domain: string, title: string}>,
 *   outcome: "answered" | "parse_error",
 *   error?: string
 * }}
 */
export function extractChatGpt(json) {
  if (!json || typeof json !== "object") {
    return { text: "", citations: [], outcome: "parse_error", error: "response is not an object" };
  }

  try {
    const output = json.output;
    if (!Array.isArray(output)) {
      return { text: "", citations: [], outcome: "parse_error", error: "no output array in response" };
    }

    const textParts = [];
    const seen = new Set();
    const citations = [];

    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "message" || item.role !== "assistant") continue;

      const content = item.content;
      if (!Array.isArray(content)) continue;

      for (const part of content) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "output_text") {
          const text = String(part.text || "");
          if (text) textParts.push(text);

          // Extract citation annotations
          const annotations = part.annotations;
          if (Array.isArray(annotations)) {
            for (const ann of annotations) {
              if (!ann || typeof ann !== "object") continue;
              if (ann.type !== "url_citation") continue;

              const url = String(ann.url || "").trim();
              if (!url) continue;
              if (seen.has(url)) continue;
              seen.add(url);

              const domain = extractDomain(url);
              const title = String(ann.title || "").trim();

              citations.push({ url, domain, title });
            }
          }
        }
      }
    }

    const text = textParts.join("\n").trim();

    // A valid response with no assistant message content is still parseable —
    // it is a legitimate empty answer, not a parse failure.
    return { text, citations, outcome: "answered" };
  } catch (e) {
    return {
      text: "",
      citations: [],
      outcome: "parse_error",
      error: e?.message || "unexpected parse error",
    };
  }
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
