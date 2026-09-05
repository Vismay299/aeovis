import { normalizeUrl } from "../scoring/citations.js";

const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || "sonar";
const MAX_RETRIES = 2;
const TIMEOUT_MS = 45000;

/**
 * Whether this probe's `citations` array is a MEASUREMENT or an absence of one
 * (R2.2.2, finding B2).
 *
 * A Perplexity probe is two independent calls: /chat/completions produces the
 * answer, /search produces the citation list. They fail independently. Before
 * this vocabulary existed, a dead /search leg returned `citations: []` and
 * `error: null` — byte-identical to a healthy /search that genuinely found
 * nothing to cite. "We asked and there were none" and "we could not ask" were
 * the same value, so every citation-share denominator downstream counted the
 * outage as a confirmed zero for the brand.
 *
 *   verified   — the /search leg answered. `citations` is a real measurement,
 *                including a genuine empty array.
 *   unverified — the /search leg never answered. `citations` is `[]` because
 *                there is nothing to put there, NOT because there were none.
 *                Excluded from citation-share denominators.
 *
 * Naming matches the `state` / `state_reason` pair the repo already uses for
 * degradable subsystems (SCRAPE_STATE in src/lib/firecrawl.js, SHARE_STATE in
 * src/components/perceev/charts/shareOfVoice.js), so a row can carry an engine
 * `state` and a `citations_state` without the two vocabularies colliding.
 */
export const CITATIONS_STATE = Object.freeze({
  VERIFIED: "verified",
  UNVERIFIED: "unverified",
});

/** Why `citations_state` is not `verified`. Machine tokens; detail carries prose. */
export const CITATIONS_STATE_REASON = Object.freeze({
  /** /search errored or timed out through every retry. The answer leg may be fine. */
  SEARCH_LEG_FAILED: "search_leg_failed",
  /** No PERPLEXITY_API_KEY, so neither leg was attempted at all. */
  NOT_CONFIGURED: "perplexity_not_configured",
});

const MAX_DETAIL_CHARS = 200;

/**
 * True when this row's citation list must NOT enter a citation-share
 * denominator: we did not observe the citations, so the row is evidence of
 * nothing either way.
 *
 * Deliberately a POSITIVE test for the unverified state rather than a
 * "is it measured?" predicate with a default. Rows from single-leg engines
 * (AIO, ChatGPT) carry no `citations_state` at all, and a default would have to
 * guess which way to read their absence; asking "was this explicitly marked
 * unverified?" needs no guess and can never quietly exclude a real measurement.
 *
 * @param {{citations_state?: string}|null|undefined} row a probe result or a
 *        persisted result row.
 */
export function hasUnverifiedCitations(row) {
  return row?.citations_state === CITATIONS_STATE.UNVERIFIED;
}

export function isPerplexityConfigured() {
  return !!process.env.PERPLEXITY_API_KEY;
}

function detailOf(value) {
  const text = String(value ?? "");
  return text.slice(0, MAX_DETAIL_CHARS) || null;
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function perplexityFetch(url, body, apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeAnswer(query, apiKey) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await perplexityFetch(
        PERPLEXITY_CHAT_URL,
        {
          model: PERPLEXITY_MODEL,
          messages: [{ role: "user", content: query }],
          web_search_options: { user_location: { country: "IN" } },
        },
        apiKey
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`Perplexity answer HTTP ${res.status}: ${errText}`);
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          if (attempt < MAX_RETRIES) {
            await delay(1000 * Math.pow(2, attempt));
            continue;
          }
        }
        throw err;
      }

      const resJson = await res.json();
      const text = resJson.choices?.[0]?.message?.content || "";
      const cost = resJson.usage?.cost?.total_cost ?? resJson.usage?.total_cost ?? 0.005;

      return { text: text.trim(), cost, error: null, usage: resJson.usage || null };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await delay(1000 * Math.pow(2, attempt));
      }
    }
  }

  return {
    text: "",
    cost: 0,
    error: lastErr?.message || "Perplexity answer probe failed",
    usage: null,
  };
}

async function probeSearch(query, apiKey) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await perplexityFetch(
        PERPLEXITY_SEARCH_URL,
        { query, max_results: 10 },
        apiKey
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`Perplexity search HTTP ${res.status}: ${errText}`);
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          if (attempt < MAX_RETRIES) {
            await delay(1000 * Math.pow(2, attempt));
            continue;
          }
        }
        throw err;
      }

      const resJson = await res.json();
      const results = resJson.results || [];

      const references = results.map((r) => ({
        href: r.url || "",
        title: r.title || "",
        source: r.title || "",
      }));

      const citations = [...new Set(references.map((r) => normalizeUrl(r.href)).filter(Boolean))];

      return { references, citations, cost: 0.005, error: null };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await delay(1000 * Math.pow(2, attempt));
      }
    }
  }

  return {
    references: [],
    citations: [],
    cost: 0,
    error: lastErr?.message || "Perplexity search probe failed",
  };
}

/**
 * Probe Perplexity: one answer call, one citation call, reported separately.
 *
 * The two legs fail independently, so the envelope reports them independently.
 * `error` remains the ANSWER leg's error — a dead /search does not invalidate a
 * real answer, and promoting it to `error` would throw away a genuine mention
 * measurement. What a dead /search does invalidate is the citation list, and
 * that is what `citations_state` says (R2.2.2, finding B2).
 *
 * @returns {Promise<{text: string, citations: string[], references: object[],
 *          cost: number, error: string|null, citations_state: string,
 *          citations_state_reason: string|null, citations_state_detail: string|null}>}
 */
export async function probePerplexity(query, options = {}) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.warn("[perplexity] PERPLEXITY_API_KEY not set — skipping");
    return {
      text: "",
      citations: [],
      references: [],
      cost: 0,
      error: "PERPLEXITY_API_KEY not set",
      // Nothing was asked, so the empty citation list is not a finding of
      // "no citations" either.
      citations_state: CITATIONS_STATE.UNVERIFIED,
      citations_state_reason: CITATIONS_STATE_REASON.NOT_CONFIGURED,
      citations_state_detail: null,
    };
  }

  const [answer, search] = await Promise.all([
    probeAnswer(query, apiKey),
    probeSearch(query, apiKey),
  ]);

  const citationsState = search.error
    ? {
        citations_state: CITATIONS_STATE.UNVERIFIED,
        citations_state_reason: CITATIONS_STATE_REASON.SEARCH_LEG_FAILED,
        citations_state_detail: detailOf(search.error),
      }
    : {
        citations_state: CITATIONS_STATE.VERIFIED,
        citations_state_reason: null,
        citations_state_detail: null,
      };

  // If answer failed entirely, return error
  if (answer.error && !answer.text) {
    // The old line here claimed BOTH legs failed whenever the answer leg did.
    // Say which one actually died: /search may well have returned citations.
    console.error(
      `[perplexity] Answer leg failed for query: "${query}" — ${answer.error} ` +
        `(citations ${citationsState.citations_state}` +
        `${citationsState.citations_state_reason ? `: ${citationsState.citations_state_reason}` : ""})`
    );
    return {
      text: "",
      citations: search.citations,
      references: search.references,
      cost: answer.cost + search.cost,
      error: answer.error,
      ...citationsState,
    };
  }

  if (search.error) {
    // The answer survived, so this row is kept and scored for mentions. Its
    // citation list is NOT a zero — say so here rather than let a silent []
    // reach a denominator.
    console.warn(
      `[perplexity] Citation leg failed for query: "${query}" — ${search.error}. ` +
        `Answer kept; citations marked ${CITATIONS_STATE.UNVERIFIED} ` +
        `(${CITATIONS_STATE_REASON.SEARCH_LEG_FAILED}), not zero.`
    );
  }

  const totalCost = answer.cost + search.cost;

  if (options.stats) {
    options.stats.cost = (options.stats.cost || 0) + totalCost;
    if (answer.usage) {
      options.stats.tokens =
        (options.stats.tokens || 0) +
        (answer.usage.prompt_tokens || 0) +
        (answer.usage.completion_tokens || 0);
    }
  }

  return {
    text: answer.text,
    citations: search.citations,
    references: search.references,
    cost: totalCost,
    error: null,
    ...citationsState,
  };
}
