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
 * Section keys that are affirmative evidence of a Google SERP, SPLIT BY THE
 * SHAPE each one ships in.
 *
 * The union is deliberately the observed shape, not one key: a no-AIO SERP is
 * often organic-only, a PAA-only probe carries people_also_ask, and the AIO
 * shape carries ai_overview. Requiring `organic` alone would misclassify two of
 * those three as unknown_schema — the same failure A01 is about, arriving on a
 * different key. A single member is enough; there is no "looks like Google"
 * score.
 *
 * THE SHAPE IS PART OF THE EVIDENCE, and that is the half this list used to be
 * missing. Presence of a key alone is satisfied by `{organic: null}`,
 * `{organic: "not-an-array"}` and `{general: null}` — none of which is a Google
 * SERP, all of which used to parse as `ok: true` / `valid_no_aio`, i.e. a false
 * healthy no-AIO observation manufactured out of an unreadable payload (A10
 * re-entering through A01). Conversely an EMPTY ARRAY is evidence: a real Google
 * page with no results still carries `organic`, with the right type, and
 * treating "no results" as failure would recreate A01 from the other side. The
 * distinction is between a shape RECOGNISABLE as a Google SERP and a shape that
 * merely carries a familiar key.
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

/** The sections that are lists of results or questions. */
const SERP_LIST_SECTIONS = new Set([
  "organic",
  "people_also_ask",
  "related_questions",
  "related_searches",
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
]);

/** How a value reads once we know it is not what its section ships in. */
function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * Does this section carry a value the section actually ships?
 *
 * A list section must be an array AND it must carry something readable: a list
 * of results is the SERP's content, and an object with no readable field in it —
 * not even a query in `general` or metadata elsewhere — has named a section but
 * shipped no evidence. `{general:{}}` used to pass on the key alone and let a
 * payload containing nothing at all through as a measured SERP. An empty ARRAY
 * is different: that is a genuine zero-result capture, and it stays valid.
 * `ai_overview` null/false is how "no overview" is expressed, but only alongside
 * other SERP evidence — a lone absent Overview is asserted absence with nothing
 * backing it, and the shape stage refuses it below. A non-empty AIO string is
 * itself readable evidence.
 */
function sectionUsable(key, value) {
  if (key === "ai_overview") {
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === "string") return Boolean(value.trim());
    return typeof value === "object" && !Array.isArray(value);
  }
  if (SERP_LIST_SECTIONS.has(key)) {
    if (!Array.isArray(value)) return false;
    return value.length === 0 || value.some((item) => sectionItemUsable(item));
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).some((field) => fieldUsable(field));
}

/**
 * Is one item of a list section readable evidence, or an empty shell?
 *
 * A result entry that is a non-empty string, a number, or an object with at
 * least one scalar field (a title, a link, a position) is content. `{}` and
 * `[{}]` in a list is the list analogue of an empty object section: the key is
 * present and the capture is not.
 */
function sectionItemUsable(item) {
  if (item === null || item === undefined) return false;
  if (typeof item === "string") return Boolean(item.trim());
  if (typeof item === "number" || typeof item === "boolean") return true;
  if (typeof item !== "object" || Array.isArray(item)) return false;
  return Object.values(item).some((field) => fieldUsable(field));
}

/**
 * Is one field inside an object section readable?
 *
 * `object_field: {}` contributes no evidence, but neither does it disqualify a
 * sibling that does: the section check is "some readable field", because a real
 * `general: {query, gl}` block next to an empty sibling is still a SERP. Nested
 * arrays count when they carry a readable item, so `organic: [{}]` differs from
 * `organic: []` (genuine zero results) and from `organic: [{title, link}]`.
 */
function fieldUsable(field) {
  if (field === null || field === undefined || field === false) return false;
  if (typeof field === "string") return Boolean(field.trim());
  if (typeof field === "number" || typeof field === "boolean") return true;
  if (Array.isArray(field)) return field.some((item) => sectionItemUsable(item));
  if (typeof field === "object") {
    return Object.values(field).some((nested) => fieldUsable(nested));
  }
  return false;
}

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

/* ===========================================================================
 * SHA-256, hand-rolled.
 *
 * WHY THIS IS HERE AT ALL. This module is imported by brightdata.js, which
 * enginePipeline.js imports, which DashboardShell.jsx imports — so the shared
 * parser is bundled for the BROWSER, and a static crypto import from the Node
 * standard library there does not degrade the bundle, it fails it:
 * `UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins`,
 * raised while building /dashboard/page.js. The parser is shared with the
 * server and nothing about parsing needs a runtime-specific primitive, so the
 * dependency is removed HERE rather than split into two copies of the parser
 * (which is exactly how the transport and the meaning of a payload drifted
 * apart before, see the module header).
 *
 * WHY IT IS SHA-256 AND NOT SOMETHING CHEAPER. `evidence_id` is a derived
 * identity that is already written into persisted evidence records, so it has
 * to keep producing the SAME digest the server-side hash produced. A 32-bit
 * string hash would be shorter, faster and would silently orphan every stored
 * id. R04-03 pins the digest against node:crypto in the test suite, which is
 * the only place a Node built-in is allowed to appear.
 *
 * `TextEncoder` utf8-encodes, which is what node:crypto's string default did,
 * so a payload with non-ASCII text hashes to the same id it always did.
 * ======================================================================== */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The lowercase hex digest of `text` read as utf8. */
function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const bitLength = bytes.length * 8;
  // One 0x80 byte, then zeroes, then the 64-bit big-endian bit length.
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** A stable, derived identity for a payload — never the payload itself. */
function evidenceId(raw) {
  let serialized;
  try {
    serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    serialized = String(raw);
  }
  return "bd_" + sha256Hex(serialized ?? "").slice(0, 24);
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

/**
 * A block's own text, in reading order, with nothing dropped.
 *
 * A block carrying both a heading and a snippet used to yield only the first of
 * them (`firstNonEmpty`), so a brand named in the heading disappeared from the
 * measurement: a mention missed because the block happened to have more than one
 * text field, which is the ordinary case for an AI Overview's titled sections.
 * Headings come first because that is where a reader starts; a string repeated in
 * two fields is kept once, so a vendor echoing itself does not lengthen the text.
 */
const BLOCK_TEXT_FIELDS = ["heading", "header", "title", "text", "snippet"];

function blockOwnText(node) {
  const parts = [];
  for (const field of BLOCK_TEXT_FIELDS) {
    const value = node[field];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || parts.includes(text)) continue;
    parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Can this `ai_overview` value be read at all, and does it assert presence?
 *
 * `null` and `false` are the vendor's explicit no-Overview signals, but only
 * when they arrive alongside other affirmative SERP evidence (which the SERP
 * shape stage enforces); a lone absent Overview is not a measurement. A
 * non-empty string asserts an Overview; an object asserts one only when at
 * least one of its content fields carries a readable value, not merely when the
 * key is present. Everything else is a shape we cannot read.
 *
 * Reading present-but-unreadable as absence is how a malformed capture came to
 * look like a healthy no-AIO observation (A01/A10). Reading it as presence is
 * the same defect one door down: the probe then extracts nothing and writes
 * `aio_present: false` over the parser's `true`, so the stored row contradicts
 * the parse. Either way the answer is not "false"; it is unknown, and the
 * payload may not be collected.
 */
const AIO_TEXT_FIELDS = ["texts", "text_blocks", "paragraphs", "text", "snippet"];
const AIO_REF_FIELDS = ["references", "sources", "citations"];

const isNonEmptyString = (value) => typeof value === "string" && Boolean(value.trim());

function aioContentHasReadableText(value) {
  if (isNonEmptyString(value)) return true;
  if (Array.isArray(value)) {
    return value.some((item) =>
      typeof item === "string"
        ? Boolean(item.trim())
        : item && typeof item === "object" &&
          (BLOCK_TEXT_FIELDS.some((field) => isNonEmptyString(item[field])) ||
            ["list", "text_blocks", "paragraphs"].some((field) => Array.isArray(item[field])))
    );
  }
  if (value && typeof value === "object") {
    return AIO_TEXT_FIELDS.some((field) => aioContentHasReadableText(value[field]));
  }
  return false;
}

function aioContentHasReadableRefs(value) {
  if (Array.isArray(value)) return true;
  if (value && typeof value === "object") {
    return AIO_REF_FIELDS.some((field) => Array.isArray(value[field]));
  }
  return false;
}

function aioReadability(aio) {
  if (aio === null || aio === undefined || aio === false) {
    return { readable: true, present: false, valueType: valueType(aio) };
  }
  if (typeof aio === "string") {
    return aio.trim()
      ? { readable: true, present: true, valueType: "string" }
      : { readable: false, valueType: "empty string" };
  }
  if (typeof aio === "object" && !Array.isArray(aio)) {
    // Presence is asserted by READABLE content, not by a familiar key:
    // `ai_overview: {}` is an empty object any shape check would pass, and
    // `{texts: null}` or `{references: "not-an-array"}` is an Overview whose
    // every extraction path finds nothing to read. Either way there is no
    // measurement to take — presence says true and the probe writes false, and
    // that contradiction is exactly what this function exists to refuse.
    const asserted = aioContentHasReadableText(aio) || aioContentHasReadableRefs(aio);
    return asserted
      ? { readable: true, present: true, valueType: "object" }
      : { readable: false, valueType: hasAioContentKey(aio) ? "unreadable aio object" : "empty object" };
  }
  return { readable: false, valueType: valueType(aio) };
}

function hasAioContentKey(aio) {
  return [...AIO_TEXT_FIELDS, ...AIO_REF_FIELDS].some((field) =>
    Object.prototype.hasOwnProperty.call(aio, field)
  );
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
    const own = blockOwnText(node);
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
    const own = blockOwnText(ao);
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
    // The answer text, joined from the blocks in reading order. Carried here so
    // the extraction path reads the parser's text instead of re-joining the
    // blocks itself: a second join is a second rule for what the text is, and
    // the AIO engine's `answer_present` hangs off it.
    text: fields.text ?? "",
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
 * The payload's own failure state, when it states one.
 *
 * A capture that reports its own failure is not a SERP with no AI Overview; it
 * is a capture that produced nothing, and the two are indistinguishable once
 * the failure is read as output. `{search_metadata: {status: "Error"}}` used to
 * do exactly that: one familiar key, `ok: true`, `aio_present: false`. Typed as
 * a provider failure rather than an unknown schema because the transport
 * succeeded and the answer did not — that is retryable and can never be filed
 * as brand absence (R04-11's distinction, on a different door).
 */
function serpFailureReason(serp) {
  const meta = serp.search_metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const status = typeof meta.status === "string" ? meta.status.trim().toLowerCase() : "";
  if (status !== "error") return null;
  const detail = firstNonEmpty([meta.error, meta.message]);
  return `Google SERP reported status "Error"${detail ? `: ${detail}` : ""}`;
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
  // A payload that states its own failure is checked BEFORE the section scan:
  // "Google said Error" and "Google returned a SERP" must not be told apart by
  // whose key happened to be present.
  const failure = serpFailureReason(serp);
  if (failure) {
    return makeResult(SERP_STATE.PROVIDER_FAILURE, {
      stage: PARSE_STAGE.ENVELOPE,
      errors: [{ stage: PARSE_STAGE.ENVELOPE, code: "serp_error_status", message: failure }],
      evidence,
    });
  }

  const recognized = [];
  const unusable = [];
  for (const key of SERP_SECTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(serp, key)) continue;
    if (sectionUsable(key, serp[key])) recognized.push(key);
    else {
      const entry = { section: key, type: valueType(serp[key]) };
      // An explicit absent-AIO signal (null/false) is the absence verdict being
      // recorded, not a section arriving broken: it can never establish a SERP
      // on its own (sectionUsable returns false for it), but once a sibling has
      // established one it must not read as a defect in the capture either.
      if (key === "ai_overview" && (serp[key] === null || serp[key] === false)) {
        entry.absentSignal = true;
      }
      unusable.push(entry);
    }
  }

  if (recognized.length === 0) {
    // Two different nothings, named separately: a payload with none of our keys
    // (a vendor shape change) and a payload with our keys carrying values we
    // cannot read. Both are unknown_schema — neither is absence.
    const onlyNames = unusable.length > 0;
    return makeResult(SERP_STATE.UNKNOWN_SCHEMA, {
      stage: PARSE_STAGE.SERP_SHAPE,
      errors: [
        {
          stage: PARSE_STAGE.SERP_SHAPE,
          code: onlyNames ? "serp_section_unusable" : "unrecognised_google_serp",
          message: onlyNames
            ? `no recognised Google SERP section carried a readable value: ${unusable
                .map((u) => `${u.section} is ${u.type}`)
                .join(", ")}`
            : "no recognised Google SERP section was present",
          recognized_sections: [],
          unusable_sections: unusable,
        },
      ],
      evidence,
    });
  }

  // A readable section made the payload a SERP, so an unreadable sibling is a
  // defect in the CAPTURE, not a verdict about it: recorded, and never allowed
  // to promote the unreadable value into a measurement. The one exception is an
  // explicit absent-AIO signal (null/false): that is the absence verdict being
  // recorded, not a section arriving broken, so emitting an error for it would
  // read as "no Overview, ALTHOUGH something is wrong" on every ordinary no-AIO
  // SERP. The `unusable_sections` audit trail on the result still names every
  // section that was recognised, so nothing is hidden by this.
  for (const u of unusable) {
    if (u.section === "ai_overview" && u.absentSignal === true) continue;
    errors.push({
      stage: PARSE_STAGE.SERP_SHAPE,
      code: "serp_section_unusable",
      section: u.section,
      message:
        `section "${u.section}" arrived as ${u.type}, which is not a shape this parser can read; ` +
        `the SERP verdict rests on ${recognized.join(", ")}`,
    });
  }

  // --- stage: AIO ---------------------------------------------------------
  const aio = Object.prototype.hasOwnProperty.call(serp, "ai_overview") ? serp.ai_overview : null;
  const readability = aioReadability(aio);
  if (!readability.readable) {
    // An Overview that is PRESENT but unreadable is not absence, and it is not
    // collection either: the AIO state stays indeterminate, so this payload may
    // not be counted as a valid observation (R04.1b). A sibling section being
    // recognisable is what used to let this through — the SERP shape was fine and
    // the Overview was quietly read as "no AIO", which is A01/A10 one layer up.
    // Typed unknown_schema with `aio_present: null`, which is also what the drift
    // alert watches, so the shape is reported for repair instead of guessed at.
    return makeResult(SERP_STATE.UNKNOWN_SCHEMA, {
      stage: PARSE_STAGE.AIO,
      aio_present: null,
      errors: [
        {
          stage: PARSE_STAGE.AIO,
          code: "aio_section_unreadable",
          value_type: readability.valueType,
          message: `ai_overview was present as ${readability.valueType} carrying no readable Overview field, so AIO presence is unknown rather than absent`,
        },
      ],
      evidence,
    });
  }
  const aioPresent = readability.present;

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
    text,
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
  const validSerps = results.filter((r) => r.serp_state === SERP_STATE.VALID_SERP);
  // Belt and braces on the one number that must never flatter: a valid SERP whose
  // AIO state is indeterminate is not a measurement. It is neither no-AIO nor
  // present, so it cannot be collected. Without this, one code path that kept
  // `serp_state: valid_serp` beside `aio_present: null` would report a malformed
  // Overview as 100% collection — the defect this repair exists to remove,
  // reappearing as arithmetic rather than as a classification.
  const valid = validSerps.filter((r) => r.aio_present === true || r.aio_present === false);
  const unmeasurable = validSerps.length - valid.length;
  const aioPresent = valid.filter((r) => r.aio_present === true).length;
  const conditionalAvailable = aioPresent > 0;
  return {
    planned,
    valid_serp: valid.length,
    valid_no_aio: valid.filter((r) => r.aio_present === false).length,
    aio_present: aioPresent,
    unmeasurable,
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
