import { normalizeUrl } from "../scoring/citations.js";

const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || "sonar";
const MAX_RETRIES = 2;
const TIMEOUT_MS = 45000;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Whether a failed Perplexity call is worth trying again (R2.2.10).
 *
 * Both legs used to guard the retry with `if (status === 429 || status >= 500)`
 * and then `throw` the error for every other status — inside a `try` whose own
 * `catch` retried unconditionally. The guard was dead: the throw landed in the
 * catch, which backed off and went round again. A 401 from a revoked key cost
 * three calls and three seconds before surfacing, and the one failure an
 * operator can actually fix looked exactly like vendor flakiness.
 *
 *   transient — rate limit, upstream fault, timeout, severed connection. The
 *               same request may well succeed in a second. Retry it.
 *   permanent — the vendor understood the request and refused it: bad or
 *               revoked key (401), forbidden (403), malformed request (400,
 *               404, 422). No amount of backoff changes the answer. Fail on
 *               the FIRST response and say why.
 *
 * Kept as an exported classification rather than an inline condition so the
 * policy is testable on its own and so both legs cannot drift apart.
 */
export const FAILURE_KIND = Object.freeze({
  TRANSIENT: "transient",
  PERMANENT: "permanent",
});

/** Statuses below 500 that are still worth another attempt. */
const TRANSIENT_STATUSES = new Set([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests
]);

/**
 * Classify an HTTP status from either leg.
 *
 * The default for something we cannot read as a status is TRANSIENT, not
 * PERMANENT: giving up early on a failure we do not understand throws away a
 * measurement, which is the more expensive mistake. We stop retrying only when
 * we can positively identify a refusal.
 *
 * @param {number} status
 * @returns {"transient"|"permanent"}
 */
export function classifyHttpStatus(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return FAILURE_KIND.TRANSIENT;
  if (code >= 500) return FAILURE_KIND.TRANSIENT;
  if (TRANSIENT_STATUSES.has(code)) return FAILURE_KIND.TRANSIENT;
  if (code >= 400) return FAILURE_KIND.PERMANENT;
  return FAILURE_KIND.TRANSIENT;
}

/**
 * The kind of a thrown failure. Only errors this module tagged carry a verdict;
 * anything else (AbortError from the timeout, a socket reset, a truncated body
 * that fails JSON.parse) is transport noise and therefore transient.
 *
 * @param {unknown} error
 * @returns {"transient"|"permanent"}
 */
export function failureKindOf(error) {
  const kind = error?.failureKind;
  return kind === FAILURE_KIND.PERMANENT || kind === FAILURE_KIND.TRANSIENT
    ? kind
    : FAILURE_KIND.TRANSIENT;
}

/** @param {unknown} error @returns {boolean} */
export function isRetryableFailure(error) {
  return failureKindOf(error) === FAILURE_KIND.TRANSIENT;
}

function httpError(leg, status, bodyText) {
  const err = new Error(`Perplexity ${leg} HTTP ${status}: ${bodyText}`);
  err.status = status;
  err.failureKind = classifyHttpStatus(status);
  return err;
}

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
  /**
   * /search was REFUSED — 401/403/4xx — so it was not retried (R2.2.10).
   *
   * Same `unverified` state as SEARCH_LEG_FAILED, because in both cases the
   * citation list was not observed and must stay out of a citation-share
   * denominator. Split from it because the operator response differs: this one
   * is a configuration fault that will repeat on every prompt of every scan
   * until a human fixes the key, not a vendor blip that may clear on its own.
   */
  SEARCH_LEG_REJECTED: "search_leg_rejected",
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
 * carry no unverified marker — `citations_state` is null on a ChatGPT row and
 * absent entirely on an AIO one, since those engines return their citations on
 * the same call as their answer and have no separate leg to lose — and a
 * default would have to guess which way to read that. Asking "was this
 * explicitly marked unverified?" needs no guess and can never quietly exclude a
 * real measurement.
 *
 * THE CALLER THAT MATTERS is summarizeEngineSlice in
 * src/lib/scoring/enginePipeline.js, which builds the citation-share pool with
 * it. R2.2.2 was rejected once for having this predicate with no production
 * caller and no field on the row for it to read.
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

/**
 * Run one leg with the retry POLICY applied, not a retry reflex (R2.2.10).
 *
 * The classification decides; there is no status test inline here and none in
 * either caller. A permanent failure leaves the loop on the first response, so
 * the call count for a 401 is 1 and not 3. Whatever finally failed is rethrown
 * with its `failureKind` intact so the caller can report the KIND, not just the
 * message.
 *
 * @param {string} leg "answer" | "search", for the failure message.
 * @param {() => Promise<any>} run one attempt.
 */
async function withRetry(leg, run) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await run();
    } catch (e) {
      lastErr = e;
      // Permanent: the vendor already answered the question. Stop here rather
      // than spend two more calls and three seconds to be refused twice more.
      if (!isRetryableFailure(e)) break;
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }

  throw lastErr ?? new Error(`Perplexity ${leg} probe failed`);
}

async function probeAnswer(query, apiKey) {
  try {
    return await withRetry("answer", async () => {
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
        throw httpError("answer", res.status, errText);
      }

      const resJson = await res.json();
      const text = resJson.choices?.[0]?.message?.content || "";
      const cost = resJson.usage?.cost?.total_cost ?? resJson.usage?.total_cost ?? 0.005;

      return {
        text: text.trim(),
        cost,
        error: null,
        error_kind: null,
        usage: resJson.usage || null,
      };
    });
  } catch (e) {
    return {
      text: "",
      cost: 0,
      error: e?.message || "Perplexity answer probe failed",
      error_kind: failureKindOf(e),
      usage: null,
    };
  }
}

async function probeSearch(query, apiKey) {
  try {
    return await withRetry("search", async () => {
      const res = await perplexityFetch(
        PERPLEXITY_SEARCH_URL,
        { query, max_results: 10 },
        apiKey
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw httpError("search", res.status, errText);
      }

      const resJson = await res.json();
      const results = resJson.results || [];

      const references = results.map((r) => ({
        href: r.url || "",
        title: r.title || "",
        source: r.title || "",
      }));

      const citations = [...new Set(references.map((r) => normalizeUrl(r.href)).filter(Boolean))];

      return { references, citations, cost: 0.005, error: null, error_kind: null };
    });
  } catch (e) {
    return {
      references: [],
      citations: [],
      cost: 0,
      error: e?.message || "Perplexity search probe failed",
      error_kind: failureKindOf(e),
    };
  }
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
 * `error_kind` (R2.2.10) says whether that `error` is worth retrying at a higher
 * level or is a configuration fault that will repeat identically on every
 * remaining prompt. It is null exactly when `error` is null.
 *
 * HONEST LIMIT of `error_kind`: probeTextEngine in enginePipeline.js copies a
 * fixed list of fields off this envelope, and `error_kind` is not yet on that
 * list, so today it reaches this module's own log line and any direct caller,
 * not the persisted row. Carrying it onto the row is a follow-up on that file
 * (owned elsewhere while R2.2.10 was built). The one failure-kind signal that
 * DOES survive the hop is `citations_state_reason`, which is already copied —
 * hence SEARCH_LEG_REJECTED below.
 *
 * @returns {Promise<{text: string, citations: string[], references: object[],
 *          cost: number, error: string|null, error_kind: string|null,
 *          citations_state: string, citations_state_reason: string|null,
 *          citations_state_detail: string|null}>}
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
      // A missing key is a config fault, not a blip: nothing will change until
      // a human sets it.
      error_kind: FAILURE_KIND.PERMANENT,
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
        // Refused vs. died: same unverified list, different operator action.
        citations_state_reason:
          search.error_kind === FAILURE_KIND.PERMANENT
            ? CITATIONS_STATE_REASON.SEARCH_LEG_REJECTED
            : CITATIONS_STATE_REASON.SEARCH_LEG_FAILED,
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
        `[${answer.error_kind}${
          answer.error_kind === FAILURE_KIND.PERMANENT
            ? ", not retried — check PERPLEXITY_API_KEY / request shape"
            : `, retried ${MAX_RETRIES + 1}x`
        }] ` +
        `(citations ${citationsState.citations_state}` +
        `${citationsState.citations_state_reason ? `: ${citationsState.citations_state_reason}` : ""})`
    );
    return {
      text: "",
      citations: search.citations,
      references: search.references,
      cost: answer.cost + search.cost,
      error: answer.error,
      error_kind: answer.error_kind,
      ...citationsState,
    };
  }

  if (search.error) {
    // The answer survived, so this row is kept and scored for mentions. Its
    // citation list is NOT a zero — say so here rather than let a silent []
    // reach a denominator.
    console.warn(
      `[perplexity] Citation leg failed for query: "${query}" — ${search.error} ` +
        `[${search.error_kind}]. ` +
        `Answer kept; citations marked ${CITATIONS_STATE.UNVERIFIED} ` +
        `(${citationsState.citations_state_reason}), not zero.`
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
    error_kind: null,
    ...citationsState,
  };
}
