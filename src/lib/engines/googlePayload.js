import { createHash } from "node:crypto";
import { normalizeUrl } from "../scoring/citations.js";

/**
 * R04 — the Google SERP payload parser, as a sequence of separately reportable
 * stages.
 *
 * WHY THIS IS A MODULE AND NOT A PATCH TO brightdata.js. The transport
 * (`brightDataSearch`) and the meaning of what arrived are different questions,
 * and the audit (finding A01/A10) is exactly what happens when they are fused:
 * the loop's only shape test was `bodyLooksTruncated`, which returns false for
 * "not truncated" and cannot tell a valid organic SERP with no AI Overview from
 * a payload Google never sent. So a malformed 200 was returned as a SERP
 * (A10) and a legitimate no-AIO SERP was scored as if nothing had been
 * collected (A01). Splitting decode / envelope / SERP-shape / AIO / blocks /
 * citations into named stages makes each of those a value the caller can act on
 * and a test can pin, instead of a boolean buried in the retry loop.
 *
 * THE ONE RULE THAT MATTERS MOST: `valid_no_aio` is (`serp_state:
 * "valid_serp"`, `aio_present: false`). Absence is only ever reported when a
 * real SERP was affirmatively recognised first; anything we do not understand
 * is `unknown_schema` with `aio_present: null`, never `false`. A vendor shape
 * change must block a no-AIO verdict, not manufacture one.
 */

export const GOOGLE_PAYLOAD_PARSER_VERSION = "google-payload/1.0.0";

/**
 * The terminal classification of one payload. Five states, chosen so that every
 * consumer decision maps to exactly one:
 *
 *   valid_serp      — a real Google SERP came back. `aio_present` is now a
 *                     boolean; false here is the honest `valid_no_aio`.
 *   unknown_schema  — JSON we can parse but do not recognise as a Google SERP.
 *                     `aio_present` is null: this is NOT absence.
 *   provider_failure— Bright Data (or the proxy session behind it) refused or
 *                     failed the request inside an HTTP 200 envelope.
 *   access_state    — Google answered with a CAPTCHA / consent / login wall.
 *                     No answer was produced and none may be substituted.
 *   malformed       — the bytes were not a payload at all (truncated JSON,
 *                     empty body, null, or an HTML proxy page).
 */
export const SERP_STATE = Object.freeze({
  VALID_SERP: "valid_serp",
  UNKNOWN_SCHEMA: "unknown_schema",
  PROVIDER_FAILURE: "provider_failure",
  ACCESS_STATE: "access_state",
  MALFORMED: "malformed",
});

/** The stage a result reached; the last one that had something to say. */
export const PARSE_STAGE = Object.freeze({
  DECODE: "decode",
  ENVELOPE: "envelope",
  SERP_SHAPE: "serp_shape",
  AIO: "aio",
  BLOCKS: "blocks",
  CITATIONS: "citations",
});

/** `per_field_quality` vocabulary for a single measurement field. */
export const FIELD_QUALITY = Object.freeze({
  COMPLETE: "complete",
  PARTIAL: "partial",
  ABSENT: "absent",
  /**
   * The field was not present in the payload at all. Distinct from `absent`,
   * which means "the payload carried this shape and it measured nothing" — a
   * text-only AI Overview has citations `unavailable`, not a verified empty
   * list (R04-07).
   */
  UNAVAILABLE: "unavailable",
});

const SAFE_URL_SCHEMES = new Set(["http:", "https:"]);

/**
 * Section keys that are affirmative evidence of a Google SERP.
 *
 * The union is deliberately the observed shape, not one key: a no-AIO SERP is
 * often organic-only, a PAA-only probe carries people_also_ask, and the AIO
 * shape carries ai_overview. Requiring `organic` alone would misclassify two of
 * those three as unknown_schema — the same failure A01 is about, arriving on a
 * different key. A single member is enough; there is no "looks like Google"
 * score.
 */
const SERP_SECTION_KEYS = [
  "general",
  "organic",
  "people_also_ask",
  "related_questions",
  "related_searches",
  "ai_overview",
  "answer_box",
  "knowledge_panel",
  "top_stories",
  "local_results",
  "news_results",
  "discussions_and_forums",
  "perspectives",
  "shopping_results",
  "images",
  "videos",
  "inline_images",
  "inline_videos",
  "twitter_results",
  "featured_snippet",
  "search_metadata",
  "search_information",
  "pagination",
];

/**
 * Strings that mean Google (or the proxy) asked a human to prove itself. Checked
 * only against HTML-looking bodies: a JSON SERP whose text happens to contain
 * the word "sign in" is still a SERP, and matching it here would turn a valid
 * answer into an access state.
 */
const ACCESS_PATTERNS = [
  /captcha/i,
  /recaptcha/i,
  /unusual traffic/i,
  /are you a robot/i,
  /verify (that )?you are (a )?human/i,
  /before you continue/i,
  /consent\.google/i,
  /accounts\.google\.com\/(v3\/)?signin/i,
  /sign in to continue/i,
  /login required/i,
  /access denied/i,
  /\/sorry\//i,
];

/** A stable, derived identity for a payload — never the payload itself. */
function evidenceId(raw) {
  let serialized;
  try {
    serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    serialized = String(raw);
  }
  return "bd_" + createHash("sha256").update(serialized ?? "").digest("hex").slice(0, 24);
}

/**
 * Keys-and-types only, for drift alerts. Values — which can carry cookies,
 * session ids or a private payload — never leave the parser (R04-22).
 */
function shapeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== "object") return typeof value;
  const out = {};
  for (const key of Object.keys(value).slice(0, 40)) {
    const v = value[key];
    out[key] = Array.isArray(v)
      ? `array(${v.length})`
      : v && typeof v === "object"
        ? "object"
        : typeof v;
  }
  return out;
}

function firstNonEmpty(values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function classifyReferenceUrl(href) {
  const raw = typeof href === "string" ? href.trim() : "";
  if (!raw) return { ok: false, code: "missing_url" };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, code: "invalid_url" };
  }
  if (!SAFE_URL_SCHEMES.has(parsed.protocol)) {
    return { ok: false, code: "unsafe_url_scheme" };
  }
  return { ok: true, normalized: normalizeUrl(raw) };
}

function refHref(ref) {
  if (typeof ref === "string") return ref;
  if (!ref || typeof ref !== "object") return "";
  return ref.href || ref.link || ref.url || "";
}

function refTitle(ref) {
  return ref && typeof ref === "object" && typeof ref.title === "string" ? ref.title : "";
}

function refSource(ref) {
  return ref && typeof ref === "object" && typeof ref.source === "string" ? ref.source : "";
}

/**
 * The reference indexes a block claims to be supported by. Bright Data carries
 * these as integers into the AIO reference array; a block with none is simply
 * unsupported, which is not an error.
 */
function blockReferenceIndexes(node) {
  const raw =
    node.reference_indexes ??
    node.referenceIndexes ??
    node.reference_index ??
    node.referenceIndex;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.map((n) => Number(n)).filter((n) => Number.isInteger(n));
}

/**
 * Flatten an AI Overview into ordered blocks.
 *
 * Order is the point (R04-04): a block's own text is emitted before the list /
 * text_blocks / paragraphs nested under it, so a heading and its items keep the
 * order a reader sees rather than the order an object happens to iterate.
 * `texts` is primary and `text_blocks` / `paragraphs` are the same fallbacks the
 * older extractor used, so a vendor shipping two shapes cannot silently switch
 * which one a measurement came from.
 */
function extractBlocks(ao) {
  const blocks = [];

  const visit = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (text) blocks.push({ text, reference_indexes: [], kind: "text" });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;

    const indexes = blockReferenceIndexes(node);
    const own = firstNonEmpty([node.snippet, node.text, node.header]);
    if (own) {
      blocks.push({ text: own, reference_indexes: indexes, kind: node.list ? "list" : "block" });
    }
    if (Array.isArray(node.list)) node.list.forEach(visit);
    if (Array.isArray(node.text_blocks)) node.text_blocks.forEach(visit);
    if (Array.isArray(node.paragraphs)) node.paragraphs.forEach(visit);
  };

  if (typeof ao === "string") {
    visit(ao);
    return blocks;
  }
  if (ao && typeof ao === "object") {
    if (Array.isArray(ao.texts)) {
      ao.texts.forEach(visit);
      return blocks;
    }
    if (Array.isArray(ao.text_blocks)) {
      ao.text_blocks.forEach(visit);
      return blocks;
    }
    if (Array.isArray(ao.paragraphs)) {
      ao.paragraphs.forEach(visit);
      return blocks;
    }
    const own = firstNonEmpty([ao.text, ao.snippet]);
    if (own) blocks.push({ text: own, reference_indexes: blockReferenceIndexes(ao), kind: "text" });
  }
  return blocks;
}

/**
 * Turn `references` / `sources` / `citations` into deduplicated, safety-checked
 * references, and keep the original index of every one so block links survive.
 *
 * Deduplication is by NORMALIZED url, so tracking-parameter variants of the
 * same article collapse to one citation while both original indexes stay on it
 * (`reference_indexes`) — that is what lets a block pointing at either index
 * still resolve to the surviving citation (R04-05).
 */
function extractReferences(ao) {
  const hasRefField =
    Array.isArray(ao?.references) || Array.isArray(ao?.sources) || Array.isArray(ao?.citations);
  const rawRefs = [
    ...(Array.isArray(ao?.references) ? ao.references : []),
    ...(Array.isArray(ao?.sources) ? ao.sources : []),
    ...(Array.isArray(ao?.citations) ? ao.citations : []),
  ];

  const entries = [];
  const indexToEntry = new Map();
  const rejected = [];
  const byNormalized = new Map();

  rawRefs.forEach((ref, index) => {
    const href = refHref(ref);
    const check = classifyReferenceUrl(href);
    if (!check.ok) {
      rejected.push({ reference_index: index, href: String(href || ""), code: check.code });
      return;
    }
    let entry = byNormalized.get(check.normalized);
    if (!entry) {
      entry = {
        href: String(href).trim(),
        normalized: check.normalized,
        title: refTitle(ref),
        source: refSource(ref),
        reference_indexes: [],
        blocks: [],
      };
      byNormalized.set(check.normalized, entry);
      entries.push(entry);
    }
    entry.reference_indexes.push(index);
    indexToEntry.set(index, entry);
  });

  return { hasRefField, rawCount: rawRefs.length, entries, indexToEntry, rejected };
}

function makeResult(serp_state, fields) {
  const ok = serp_state === SERP_STATE.VALID_SERP;
  return {
    stage: fields.stage ?? PARSE_STAGE.DECODE,
    ok,
    serp_state,
    aio_present: fields.aio_present ?? null,
    blocks: fields.blocks ?? [],
    citations: fields.citations ?? [],
    references: fields.references ?? [],
    per_field_quality: fields.per_field_quality ?? {
      text: FIELD_QUALITY.ABSENT,
      citations: FIELD_QUALITY.ABSENT,
    },
    citations_verified_empty: fields.citations_verified_empty ?? false,
    errors: fields.errors ?? [],
    parser_version: GOOGLE_PAYLOAD_PARSER_VERSION,
    evidence: fields.evidence,
  };
}

/**
 * Parse one Bright Data Google SERP payload.
 *
 * `raw` may be the HTTP body as a string, a parsed Bright Data envelope
 * (`{ body: "<json>", headers, status_code }`), or the SERP object directly —
 * the transport and the parser must tolerate all three, because the audit's A03
 * equivalence claim (direct vs string-body) is only true if they normalise the
 * same (R04-03).
 *
 * @param {unknown} raw
 * @param {{ providerRequestId?: string|null }} [options]
 * @returns {ReturnType<typeof makeResult>}
 */
export function parseGoogleSerp(raw, options = {}) {
  const providerRequestId = options.providerRequestId ?? null;
  const errors = [];
  const evidence = {
    evidence_id: evidenceId(raw),
    parser_version: GOOGLE_PAYLOAD_PARSER_VERSION,
    provider_request_id: providerRequestId,
    shape: null,
  };

  // --- stage: DECODE ------------------------------------------------------
  if (raw === null || raw === undefined) {
    return makeResult(SERP_STATE.MALFORMED, {
      stage: PARSE_STAGE.DECODE,
      errors: [{ stage: PARSE_STAGE.DECODE, code: "null_payload", message: "payload is null" }],
      evidence,
    });
  }

  if (typeof raw === "string" && !raw.trim()) {
    return makeResult(SERP_STATE.MALFORMED, {
      stage: PARSE_STAGE.DECODE,
      errors: [{ stage: PARSE_STAGE.DECODE, code: "empty_body", message: "payload is an empty body" }],
      evidence,
    });
  }

  // --- stage: ENVELOPE ----------------------------------------------------
  let decoded = raw;
  if (typeof raw === "string") {
    const asHtml = classifyHtml(raw);
    if (asHtml) return finishHtml(asHtml, errors, evidence);
    try {
      decoded = JSON.parse(raw);
    } catch (err) {
      return makeResult(SERP_STATE.MALFORMED, {
        stage: PARSE_STAGE.DECODE,
        errors: [
          {
            stage: PARSE_STAGE.DECODE,
            code: "json_decode_error",
            message: `payload was not valid JSON: ${err.message}`,
          },
        ],
        evidence,
      });
    }
  }

  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    // A JSON scalar or array is not a Bright Data envelope and not a SERP.
    return makeResult(SERP_STATE.UNKNOWN_SCHEMA, {
      stage: PARSE_STAGE.SERP_SHAPE,
      errors: [
        {
          stage: PARSE_STAGE.SERP_SHAPE,
          code: "non_object_payload",
          message: `expected an object, got ${Array.isArray(decoded) ? "array" : typeof decoded}`,
        },
      ],
      evidence,
    });
  }

  evidence.provider_request_id = providerRequestId || providerRequestIdFrom(decoded);

  const providerReason = providerFailureReason(decoded);
  if (providerReason) {
    return makeResult(SERP_STATE.PROVIDER_FAILURE, {
      stage: PARSE_STAGE.ENVELOPE,
      errors: [
        {
          stage: PARSE_STAGE.ENVELOPE,
          code: "provider_failure",
          message: providerReason,
        },
      ],
      evidence,
    });
  }

  // Unwrap the Bright Data `body` (a JSON string, or a nested object).
  let serp = decoded;
  if (Object.prototype.hasOwnProperty.call(decoded, "body")) {
    const body = decoded.body;
    if (typeof body === "string") {
      const asHtml = classifyHtml(body);
      if (asHtml) return finishHtml(asHtml, errors, evidence);
      if (!body.trim()) {
        return makeResult(SERP_STATE.MALFORMED, {
          stage: PARSE_STAGE.ENVELOPE,
          errors: [
            {
              stage: PARSE_STAGE.ENVELOPE,
              code: "empty_body",
              message: "envelope carried an empty body",
            },
          ],
          evidence,
        });
      }
      try {
        serp = JSON.parse(body);
      } catch (err) {
        return makeResult(SERP_STATE.MALFORMED, {
          stage: PARSE_STAGE.ENVELOPE,
          errors: [
            {
              stage: PARSE_STAGE.ENVELOPE,
              code: "json_decode_error",
              message: `envelope body was not valid JSON: ${err.message}`,
            },
          ],
          evidence,
        });
      }
    } else if (body && typeof body === "object") {
      serp = body;
    } else {
      // body present but null/number/etc: nothing to parse.
      return makeResult(SERP_STATE.MALFORMED, {
        stage: PARSE_STAGE.ENVELOPE,
        errors: [
          {
            stage: PARSE_STAGE.ENVELOPE,
            code: "empty_body",
            message: "envelope body was neither an object nor a JSON string",
          },
        ],
        evidence,
      });
    }
  }

  if (typeof serp !== "object" || serp === null || Array.isArray(serp)) {
    return makeResult(SERP_STATE.UNKNOWN_SCHEMA, {
      stage: PARSE_STAGE.SERP_SHAPE,
      errors: [
        {
          stage: PARSE_STAGE.SERP_SHAPE,
          code: "non_object_payload",
          message: "unwrapped body was not an object",
        },
      ],
      evidence,
    });
  }

  evidence.shape = shapeOf(serp);

  // --- stage: SERP_SHAPE --------------------------------------------------
  const recognized = SERP_SECTION_KEYS.filter(
    (key) => Object.prototype.hasOwnProperty.call(serp, key)
  );
  if (recognized.length === 0) {
    return makeResult(SERP_STATE.UNKNOWN_SCHEMA, {
      stage: PARSE_STAGE.SERP_SHAPE,
      errors: [
        {
          stage: PARSE_STAGE.SERP_SHAPE,
          code: "unrecognised_google_serp",
          message: "no recognised Google SERP section was present",
          recognized_sections: [],
        },
      ],
      evidence,
    });
  }

  // --- stage: AIO ---------------------------------------------------------
  const aio = Object.prototype.hasOwnProperty.call(serp, "ai_overview") ? serp.ai_overview : null;
  const aioPresent = aio !== null && aio !== undefined && aio !== false;

  // --- stage: BLOCKS + CITATIONS -----------------------------------------
  const blocks = aioPresent ? extractBlocks(aio) : [];
  const { hasRefField, rawCount, entries, indexToEntry, rejected } = aioPresent
    ? extractReferences(aio)
    : { hasRefField: false, rawCount: 0, entries: [], indexToEntry: new Map(), rejected: [] };

  for (const r of rejected) {
    errors.push({
      stage: PARSE_STAGE.CITATIONS,
      code: r.code,
      reference_index: r.reference_index,
      href: r.href,
      message: `reference ${r.reference_index} rejected: ${r.code}`,
    });
  }

  blocks.forEach((block, order) => {
    block.order = order;
    block.citation_indexes = [];
    block.citation_urls = [];
    for (const index of block.reference_indexes) {
      if (index < 0 || index >= rawCount) {
        errors.push({
          stage: PARSE_STAGE.BLOCKS,
          code: "reference_index_out_of_range",
          reference_index: index,
          block_order: order,
          message: `block ${order} claims reference ${index}, outside the ${rawCount} references present`,
        });
        continue;
      }
      const entry = indexToEntry.get(index);
      if (!entry) continue; // the reference itself was rejected — already recorded above
      if (!entry.blocks.includes(order)) entry.blocks.push(order);
      // Two indexes that survived deduplication to one citation must appear once
      // on the block's link, not twice — otherwise a block's support count is
      // inflated by a tracking-parameter variant of the same URL.
      const entryIndex = entries.indexOf(entry);
      if (!block.citation_indexes.includes(entryIndex)) {
        block.citation_indexes.push(entryIndex);
        block.citation_urls.push(entry.normalized);
      }
    }
  });

  const text = blocks.map((b) => b.text).filter(Boolean).join("\n").trim();
  // A reference-only Overview yields citations but no measurable text: the text
  // quality is PARTIAL, never complete, so no mention measurement may be taken
  // from it (R04-06).
  const textQuality = !aioPresent
    ? FIELD_QUALITY.ABSENT
    : text
      ? FIELD_QUALITY.COMPLETE
      : FIELD_QUALITY.PARTIAL;

  let citationQuality;
  if (!aioPresent) citationQuality = FIELD_QUALITY.ABSENT;
  else if (!hasRefField) citationQuality = FIELD_QUALITY.UNAVAILABLE;
  else if (rejected.length > 0) citationQuality = FIELD_QUALITY.PARTIAL;
  else citationQuality = FIELD_QUALITY.COMPLETE;

  return makeResult(SERP_STATE.VALID_SERP, {
    stage: PARSE_STAGE.CITATIONS,
    aio_present: aioPresent,
    blocks,
    citations: entries.map((e) => e.normalized),
    references: entries,
    per_field_quality: { text: textQuality, citations: citationQuality },
    citations_verified_empty: aioPresent && hasRefField && rawCount === 0,
    errors,
    evidence,
  });
}

function providerRequestIdFrom(decoded) {
  const headers = decoded?.headers;
  if (!headers || typeof headers !== "object") return null;
  return headers["x-brd-request-id"] || headers["x-request-id"] || null;
}

function providerFailureReason(decoded) {
  const headers = decoded.headers && typeof decoded.headers === "object" ? decoded.headers : {};
  const brdError = headers["x-brd-error"] || headers["x-brd-error-code"];
  const bodyEmpty = decoded.body === "" || decoded.body === undefined;
  if (brdError) return `proxy session failure: ${brdError}`;
  if (typeof decoded.error === "string" && decoded.error.trim()) return decoded.error.trim();
  if (decoded.status === "error") {
    return String(decoded.message || decoded.error || "provider returned status:error");
  }
  if (typeof decoded.status_code === "number" && decoded.status_code >= 400 && bodyEmpty) {
    return `proxy status ${decoded.status_code}`;
  }
  return null;
}

/** Returns "access" or "html" for an HTML-looking body, else null. */
function classifyHtml(body) {
  const trimmed = String(body).trimStart();
  if (!trimmed.startsWith("<") && !/^<!DOCTYPE/i.test(trimmed)) return null;
  return ACCESS_PATTERNS.some((re) => re.test(body)) ? "access" : "html";
}

function finishHtml(kind, errors, evidence) {
  if (kind === "access") {
    return makeResult(SERP_STATE.ACCESS_STATE, {
      stage: PARSE_STAGE.ENVELOPE,
      errors: [
        {
          stage: PARSE_STAGE.ENVELOPE,
          code: "access_challenge",
          message: "Google returned a CAPTCHA / consent / login page instead of a SERP",
        },
      ],
      evidence,
    });
  }
  return makeResult(SERP_STATE.MALFORMED, {
    stage: PARSE_STAGE.ENVELOPE,
    errors: [
      {
        stage: PARSE_STAGE.ENVELOPE,
        code: "html_response",
        message: "response was an HTML page, not a JSON SERP",
      },
    ],
    evidence,
  });
}

/**
 * The monitoring signal for a shape this parser does not know (R04-22).
 *
 * It carries the parser version, the shape (keys and types only) and the
 * derived evidence id — never the payload, and never a header value that could
 * hold a cookie or token. `null` when there is nothing to alert on, so a caller
 * can `if (alert)` rather than re-deriving the condition.
 */
export function buildParserDriftAlert(result) {
  if (!result || result.serp_state !== SERP_STATE.UNKNOWN_SCHEMA) return null;
  return {
    code: "parser_drift_unknown_schema",
    parser_version: result.parser_version,
    shape: result.evidence?.shape ?? null,
    evidence_id: result.evidence?.evidence_id ?? null,
    provider_request_id: result.evidence?.provider_request_id ?? null,
  };
}

/**
 * Collection health over a batch of parsed payloads (R04-20 and the R03
 * contract).
 *
 * Valid no-AIO is VALID COLLECTION: a real SERP with no Overview is a
 * measurement, not a failure. So `collection_pct` divides by every planned
 * payload, and the trigger rate divides by the valid SERPs only — a
 * `valid_no_aio` present here lowers the trigger rate and never the collection
 * completion. The conditional AIO score is `null` with an explicit reason when
 * no valid SERP carried an Overview, so "no AIO at all" can never render as a
 * confident zero.
 */
export function summarizeSerpCollection(results = []) {
  const planned = results.length;
  const valid = results.filter((r) => r.serp_state === SERP_STATE.VALID_SERP);
  const aioPresent = valid.filter((r) => r.aio_present === true).length;
  const conditionalAvailable = aioPresent > 0;
  return {
    planned,
    valid_serp: valid.length,
    valid_no_aio: valid.filter((r) => r.aio_present === false).length,
    aio_present: aioPresent,
    failed: planned - valid.length,
    collection_pct: planned > 0 ? (valid.length / planned) * 100 : null,
    collection_complete: planned > 0 && valid.length === planned,
    trigger_rate_pct: valid.length > 0 ? (aioPresent / valid.length) * 100 : null,
    conditional_aio_score: null,
    conditional_aio_score_available: conditionalAvailable,
    conditional_aio_score_reason: conditionalAvailable
      ? null
      : "no valid SERP carried an AI Overview, so there is no conditional AIO value to report",
  };
}
