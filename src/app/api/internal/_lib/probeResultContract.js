/**
 * Probe Result Contract v2, as an executable validator (R1.2.4).
 *
 * `docs/contracts/probe-result.md` §3 is normative prose; this file is the same
 * rules as code, and §5 is why it exists:
 *
 *   > The R1.2.4 ingest route **must** validate against §3 and **must** answer
 *   > `422` on a body that fails it. It **must not** repair, default, or coerce.
 *   > A rejected probe result is not written and the task is left for retry.
 *
 * So every function below REJECTS. Nothing here defaults a missing field,
 * coerces a type, or repairs a contradiction — a row that would need repairing
 * is a row whose producer is wrong, and the cheapest place to find that out is
 * the boundary (§5's refusal precedent: `worker/src/lib/probe.js` throws rather
 * than returning zero-valued rows).
 *
 * Pure: no imports, no I/O, no `next/server`. Every branch is reachable from a
 * unit test without a server, and the route is a thin shell over it.
 *
 * WHY A `_lib` FOLDER. Next treats an underscore-prefixed directory under `app/`
 * as private — it is never routed — which is the same shape
 * `src/app/api/scans/_lib/scanRow.js` already uses. The validator therefore
 * lives next to its only caller without becoming an endpoint of its own.
 *
 * ------------------------------------------------------------------------
 * ONE PLACE WHERE §3 CONTRADICTS ITSELF, AND HOW THIS FILE RESOLVES IT
 * ------------------------------------------------------------------------
 * §3.4 and §5 say every measurement field must be non-null when `state` is
 * `answered` ("any §3.4 field null when `state` is `answered`" is a mandatory
 * rejection). §6.3 is a worked example the contract calls legitimate — an
 * `answered` row with `citations_state: "unverified"`, `brand_cited: null` and
 * `competitors_cited: null` — and §3.10 exists specifically so that row is
 * representable ("an answer was obtained but the citation channel failed").
 * Read literally, §5 rejects §6.3.
 *
 * This validator implements §3.10 as a NARROW exception to §3.4, scoped to
 * exactly the two citation-derived fields in {@link CITATION_DERIVED_FIELDS} and
 * only when `citations_state === "unverified"`. Every other measurement field
 * still has to be non-null on an `answered` row. The contradiction is real and
 * belongs in the document rather than being silently absorbed here; it is
 * reported as a follow-up rather than patched, because this task does not edit
 * `docs/contracts/`.
 *
 * The consequence §3.10 does not state: with `brand_cited` unknown, `visible`
 * is only establishable when a MENTION was observed. A row claiming
 * `visible: false` with `brand_cited: null` asserts a measured non-mention it
 * did not make — the §1 failure — so it is rejected
 * (`visibility_unestablished`) rather than stored.
 */

/** The literal every v2 row must carry (§3.1). */
export const CONTRACT_VERSION = 2;

/**
 * The eight states (§3.2). Copied from the same list frozen at
 * `worker/src/lib/probe.js` and constrained by `probe_tasks_outcome_chk` in
 * `supabase/migrations/010_probe_tasks.sql` — three representations of one
 * vocabulary, which §8 requires be changed in a single commit.
 */
export const PROBE_STATES = Object.freeze([
  "answered",
  "no_answer",
  "blocked",
  "captcha",
  "login_wall",
  "timeout",
  "parse_error",
  "skipped",
]);

/** Registry names (§3.1). */
export const PROBE_ENGINES = Object.freeze(["aio", "chatgpt", "perplexity"]);

/** §3.5. Required on every row; there is no default and no inference. */
export const ENGINE_SURFACES = Object.freeze(["ui", "api"]);

/** §3.9. `no_charge` is the fourth value and the reason §3.9 was rewritten. */
export const COST_BASES = Object.freeze([
  "vendor_reported",
  "estimated",
  "no_charge",
  "unpriced",
]);

/** §3.10. */
export const CITATIONS_STATES = Object.freeze(["measured", "unverified", "not_applicable"]);

/**
 * §3.4's nine fields: required when `answered`, `null` for every other state.
 * `false` means measured-and-absent, `null` means not measured, `[]` means
 * measured and empty.
 */
export const MEASUREMENT_FIELDS = Object.freeze([
  "text",
  "citations",
  "references",
  "brand_mentioned_in_text",
  "brand_cited",
  "visible",
  "competitors_found_in_text",
  "competitors_cited",
  "brands",
]);

/**
 * The only two §3.4 fields that may be null on an `answered` row, and only when
 * `citations_state` is `unverified` (§3.10; see the header note). Both are
 * derived from the citation channel, which is the channel §3.10 describes
 * failing on its own.
 */
export const CITATION_DERIVED_FIELDS = Object.freeze(["brand_cited", "competitors_cited"]);

/** The four evidence ids (§3.7). The object is required in every state. */
export const EVIDENCE_IDS = Object.freeze(["screenshot_id", "dom_id", "har_id", "raw_id"]);

/** snake_case, per §3.3 — a closed discriminator, never a free-text message. */
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/** ISO-8601 in UTC (§3.1 `probed_at`). A local-time stamp is not accepted. */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** ISO-3166-1 alpha-2, lowercase, as ACTUALLY used (§3.6). */
const GEO_CODE = /^[a-z]{2}$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Present-and-null and absent are both "no value"; a real value is not. */
function isNullish(row, field) {
  return !Object.prototype.hasOwnProperty.call(row, field) || row[field] === null;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** A collector so one bad row reports every violation, not only the first. */
function collector() {
  const violations = [];
  return {
    violations,
    /**
     * @param {string} field the contract field at fault
     * @param {string} code  a snake_case machine code
     * @param {string} detail what is wrong, and which section says so
     */
    add(field, code, detail) {
      violations.push({ field, code, detail });
    },
  };
}

/**
 * Validate ONE probe result against §3.
 *
 * @param {unknown} row
 * @returns {{ok: boolean, violations: Array<{field: string, code: string, detail: string}>}}
 */
export function validateProbeResult(row) {
  const v = collector();

  if (!isPlainObject(row)) {
    v.add("/", "not_an_object", "a probe result must be a JSON object (§3)");
    return { ok: false, violations: v.violations };
  }

  // ---------------------------------------------------------------- §3.1
  if (row.contract_version !== CONTRACT_VERSION) {
    // Strict !==: the string "2" is a producer that has not been updated, and
    // coercing it would be the repair §5 forbids.
    v.add(
      "contract_version",
      "contract_version",
      `must be the integer ${CONTRACT_VERSION} (§3.1)`
    );
  }
  if (!PROBE_ENGINES.includes(row.engine)) {
    v.add("engine", "unknown_engine", `must be one of ${PROBE_ENGINES.join(", ")} (§3.1)`);
  }
  if (!ENGINE_SURFACES.includes(row.engine_surface)) {
    v.add(
      "engine_surface",
      "unknown_engine_surface",
      `must be "ui" or "api" — there is no default and no inference from engine (§3.5)`
    );
  }
  if (!isNonEmptyString(row.query)) {
    v.add("query", "query_empty", "must be the exact non-empty text sent (§3.1)");
  }
  if (typeof row.geo !== "string" || !GEO_CODE.test(row.geo)) {
    v.add(
      "geo",
      "geo_invalid",
      "must be a lowercase ISO-3166-1 alpha-2 code, as actually used; a producer that " +
        'does not know it must emit state "skipped" with state_reason "geo_unresolved" (§3.6)'
    );
  }
  if (typeof row.probed_at !== "string" || !ISO_8601_UTC.test(row.probed_at) || Number.isNaN(Date.parse(row.probed_at))) {
    v.add("probed_at", "probed_at_invalid", "must be an ISO-8601 UTC instant ending in Z (§3.1)");
  }
  if (!Number.isInteger(row.attempt) || row.attempt < 1) {
    v.add("attempt", "attempt_invalid", "must be an integer >= 1 (§3.1)");
  }

  // ---------------------------------------------------------------- §3.2
  const state = row.state;
  const known = PROBE_STATES.includes(state);
  if (!known) {
    v.add(
      "state",
      "unknown_state",
      `must be exactly one of the eight frozen outcomes: ${PROBE_STATES.join(", ")} (§3.2). ` +
        "A ninth value is a migration, an edit to worker/src/lib/probe.js and an edit to the " +
        "contract, in one commit (§8)."
    );
  }
  const answered = state === "answered";

  // ---------------------------------------------------------------- §3.3
  if (answered) {
    if (!isNullish(row, "state_reason")) {
      v.add(
        "state_reason",
        "state_reason_on_answered",
        "must be null on an answered row — there is no absence to discriminate (§3.1/§3.3)"
      );
    }
  } else if (known) {
    if (!isNonEmptyString(row.state_reason)) {
      v.add(
        "state_reason",
        "state_reason_missing",
        `is required and non-empty for state "${state}" (§3.3). A skip with no reason is the ` +
          "discarded fact this phase exists to keep."
      );
    } else if (!SNAKE_CASE.test(row.state_reason)) {
      v.add(
        "state_reason",
        "state_reason_not_snake_case",
        "must be snake_case from a per-state closed list; free-text detail belongs in " +
          "error_detail (§3.3/§3.10)"
      );
    }
  }

  // ---------------------------------------------------------------- §3.10
  const citationsState = row.citations_state;
  if (!CITATIONS_STATES.includes(citationsState)) {
    v.add(
      "citations_state",
      "unknown_citations_state",
      `must be one of ${CITATIONS_STATES.join(", ")}, on every row in every state (§3.10/§4)`
    );
  } else if (answered && citationsState === "not_applicable") {
    v.add(
      "citations_state",
      "citations_state_not_applicable_on_answered",
      '"not_applicable" means state is not answered, so citations is null (§3.10)'
    );
  } else if (known && !answered && citationsState !== "not_applicable") {
    v.add(
      "citations_state",
      "citations_state_claims_measurement",
      `state "${state}" measured no answer, so citations_state must be "not_applicable" — ` +
        "this is rejection 2 of the worked §6.5 example (§3.10/§5)"
    );
  }

  // ---------------------------------------------------------------- §3.4
  const unverified = citationsState === "unverified";
  if (answered) {
    validateAnsweredMeasurements(row, { unverified, add: v.add });
  } else if (known) {
    for (const field of MEASUREMENT_FIELDS) {
      if (!isNullish(row, field)) {
        v.add(
          field,
          "measurement_on_unmeasured_row",
          `must be null when state is "${state}" — a non-null value claims a measurement this ` +
            "row did not make, which is the original bug of §6.5 (§3.4/§5)"
        );
      }
    }
  }

  // ---------------------------------------------------------------- §3.8
  validateTimings(row, { answered, add: v.add });

  // ---------------------------------------------------------------- §3.7
  validateEvidence(row, { add: v.add });

  // ---------------------------------------------------------------- §3.9
  validateCost(row, { add: v.add });

  // ------------------------------------------------------- §4, engine-optional
  // "An engine-optional field that is absent must be omitted or null, never 0,
  // "" or []" — so a PRESENT one is still type-checked.
  if (!isNullish(row, "error_detail") && typeof row.error_detail !== "string") {
    v.add("error_detail", "error_detail_not_a_string", "free-text detail must be a string (§3.10)");
  }
  if (!isNullish(row, "is_branded_query") && typeof row.is_branded_query !== "boolean") {
    // Not a §3.1 field, but `prompt_results.is_branded_query` is what every
    // coverage denominator filters on, so a producer that sends it must send a
    // boolean rather than something truthy.
    v.add("is_branded_query", "is_branded_query_not_boolean", "must be a boolean when present");
  }
  if (!isNullish(row, "brand_organic_position") && typeof row.brand_organic_position !== "number") {
    v.add("brand_organic_position", "brand_organic_position_not_a_number", "must be a number or null (§4)");
  }
  if (!isNullish(row, "organic") && !Array.isArray(row.organic)) {
    v.add("organic", "organic_not_an_array", "must be an array or null/omitted (§4)");
  }

  return { ok: v.violations.length === 0, violations: v.violations };
}

/** §3.4 under `answered`, plus the §3.10 narrowing and the derived-`visible` rule. */
function validateAnsweredMeasurements(row, { unverified, add }) {
  for (const field of MEASUREMENT_FIELDS) {
    const mayBeNull = unverified && CITATION_DERIVED_FIELDS.includes(field);
    if (isNullish(row, field) && !mayBeNull) {
      add(
        field,
        "measurement_missing_on_answered",
        `is required and non-null when state is "answered" (§3.4). Only ` +
          `${CITATION_DERIVED_FIELDS.join(" and ")} may be null, and only when citations_state ` +
          `is "unverified" (§3.10).`
      );
    }
  }

  if (!isNullish(row, "text") && typeof row.text !== "string") {
    add("text", "text_not_a_string", "must be a string when answered (§3.4)");
  }
  if (row.text === "" && !(Array.isArray(row.citations) && row.citations.length > 0)) {
    add(
      "text",
      "empty_text_without_citations",
      'may be "" only if citations is non-empty; an empty chat body is parse_error, never ' +
        "answered (§3.2/§3.4)"
    );
  }

  for (const field of ["citations", "competitors_found_in_text", "competitors_cited"]) {
    if (isNullish(row, field)) continue;
    if (!Array.isArray(row[field]) || row[field].some((s) => typeof s !== "string")) {
      add(field, "not_a_string_array", "must be an array of strings when answered (§3.4)");
    }
  }
  if (!isNullish(row, "references")) {
    if (!Array.isArray(row.references) || row.references.some((r) => !isPlainObject(r) || typeof r.href !== "string")) {
      add(
        "references",
        "references_malformed",
        "must be an array of {href,title,source,domain} objects with a string href (§3.4)"
      );
    }
  }
  for (const field of ["brand_mentioned_in_text", "brand_cited", "visible"]) {
    if (isNullish(row, field)) continue;
    if (typeof row[field] !== "boolean") {
      add(field, "not_a_boolean", "must be a boolean when answered (§3.4)");
    }
  }
  if (!isNullish(row, "brands")) {
    const bad =
      !Array.isArray(row.brands) ||
      row.brands.some(
        (b) =>
          !isPlainObject(b) ||
          !isNonEmptyString(b.name) ||
          typeof b.is_self !== "boolean" ||
          typeof b.mentioned !== "boolean" ||
          (b.position !== null && typeof b.position !== "number") ||
          (b.sentiment !== null && typeof b.sentiment !== "number")
      );
    if (bad) {
      add(
        "brands",
        "brands_malformed",
        "must be an array of {name,is_self,mentioned,position,sentiment}; position and sentiment " +
          "are null — never 0 — when not mentioned (§3.4)"
      );
    }
  }

  // `visible` is DERIVED, not independent (§3.4): a producer must not report a
  // visible that disagrees with its own two components.
  const mentioned = row.brand_mentioned_in_text;
  const cited = row.brand_cited;
  if (typeof mentioned === "boolean" && typeof cited === "boolean") {
    if (row.visible !== (mentioned || cited)) {
      add(
        "visible",
        "visible_disagrees_with_components",
        "must equal brand_mentioned_in_text || brand_cited (§3.4/§5)"
      );
    }
  } else if (typeof mentioned === "boolean" && cited === null) {
    // §3.10's row: the citation channel failed, so half of `visible`'s
    // definition is unknown. A mention was observed -> visible is true on the
    // strength of the mention alone (§6.3). No mention observed -> visibility is
    // NOT established, and a boolean either way would be a fabrication.
    if (!mentioned) {
      add(
        "visible",
        "visibility_unestablished",
        "cannot be established: brand_cited is null (citations unverified) and no mention was " +
          "observed, so neither true nor false is a measurement this row made (§3.4/§3.10)"
      );
    } else if (row.visible !== true) {
      add(
        "visible",
        "visible_disagrees_with_components",
        "must be true when a mention was observed (§3.4/§6.3)"
      );
    }
  }
}

/** §3.8. `total_ms` is the evidence for a timeout, so it is required in every state. */
function validateTimings(row, { answered, add }) {
  const timings = row.timings;
  if (!isPlainObject(timings)) {
    add("timings", "timings_missing", "the timings object is required in every state (§3.8)");
    return;
  }
  if (!isNonNegativeInteger(timings.total_ms)) {
    add(
      "timings.total_ms",
      "total_ms_missing",
      "is required in every state, including timeout — the elapsed time IS the evidence (§3.8)"
    );
  }
  const isUi = row.engine_surface === "ui";
  if (isUi) {
    if (!isNonNegativeInteger(timings.navigation_ms)) {
      add("timings.navigation_ms", "navigation_ms_missing", 'is required for engine_surface "ui" (§3.8)');
    }
  } else if (row.engine_surface === "api" && !isNullish(timings, "navigation_ms")) {
    add(
      "timings.navigation_ms",
      "navigation_ms_on_api",
      'must be null for engine_surface "api" — nothing navigated (§3.8)'
    );
  }
  if (answered) {
    if (!isNonNegativeInteger(timings.extract_ms)) {
      add("timings.extract_ms", "extract_ms_missing", 'is required when state is "answered" (§3.8)');
    }
  } else if (!isNullish(timings, "extract_ms") && !isNonNegativeInteger(timings.extract_ms)) {
    add("timings.extract_ms", "extract_ms_invalid", "must be a non-negative integer or null (§3.8)");
  }
}

/** §3.7. Failure evidence is how a block gets debugged, so it is required in every state. */
function validateEvidence(row, { add }) {
  const evidence = row.evidence;
  if (!isPlainObject(evidence)) {
    add(
      "evidence",
      "evidence_missing",
      "the evidence object is required on every row, in every state, including failures (§3.7)"
    );
    return;
  }
  for (const id of EVIDENCE_IDS) {
    if (isNullish(evidence, id)) continue;
    if (!isNonEmptyString(evidence[id])) {
      add(`evidence.${id}`, "evidence_id_not_a_string", "must be a non-empty string or null (§3.7)");
    }
  }
  const surface = row.engine_surface;
  if (surface === "ui") {
    const hasOne = isNonEmptyString(evidence.screenshot_id) || isNonEmptyString(evidence.dom_id);
    if (!hasOne) {
      add(
        "evidence",
        "ui_row_without_evidence",
        'engine_surface "ui" requires at least one of screenshot_id or dom_id to be non-null in ' +
          "every state — rejection 3 of the worked §6.5 example (§3.7/§5)"
      );
    }
  } else if (surface === "api" && !isNonEmptyString(evidence.raw_id)) {
    add(
      "evidence.raw_id",
      "api_row_without_raw_id",
      'engine_surface "api" requires a non-null raw_id (§3.7)'
    );
  }
}

/**
 * §3.9. Standing rule 3 of the rebuild — an unpriced model id fails loud, never
 * $0 — is what `unpriced` enforces here, and `no_charge` is the narrow reasoned
 * exception to it rather than a way around it.
 */
function validateCost(row, { add }) {
  const cost = row.cost;
  if (!isPlainObject(cost)) {
    add("cost", "cost_missing", "the cost object is required (§3.1/§3.9)");
    return;
  }
  if (!COST_BASES.includes(cost.basis)) {
    add("cost.basis", "unknown_cost_basis", `must be one of ${COST_BASES.join(", ")} (§3.9)`);
    return;
  }
  const amount = Object.prototype.hasOwnProperty.call(cost, "amount_usd") ? cost.amount_usd : undefined;
  const amountIsNumber = typeof amount === "number" && Number.isFinite(amount);
  if (amount !== null && amount !== undefined && !amountIsNumber) {
    add("cost.amount_usd", "amount_not_a_number", "must be a finite number or null (§3.9)");
  }
  if (!isNullish(cost, "reason") && typeof cost.reason !== "string") {
    add("cost.reason", "cost_reason_not_a_string", "must be a string or null (§3.9)");
  }

  const basis = cost.basis;
  if (basis === "unpriced") {
    if (!isNullish(cost, "amount_usd")) {
      add(
        "cost.amount_usd",
        "unpriced_with_amount",
        'basis "unpriced" means nobody priced this call, so amount_usd must be null — never 0. ' +
          "This is rejection 4 of the worked §6.5 example (§3.9/§5)"
      );
    }
    return;
  }

  if (basis === "no_charge") {
    if (amount !== 0) {
      add(
        "cost.amount_usd",
        "no_charge_with_nonzero_amount",
        'basis "no_charge" must carry amount_usd exactly 0 (§3.9/§5)'
      );
    }
    if (!isNonEmptyString(cost.reason)) {
      add(
        "cost.reason",
        "no_charge_without_reason",
        '"this cost nothing" is a claim about the world an operator must be able to audit, so ' +
          'basis "no_charge" must name its rule in reason (§3.9/§5)'
      );
    }
    return;
  }

  // vendor_reported / estimated
  if (!amountIsNumber) {
    add(
      "cost.amount_usd",
      "priced_basis_without_amount",
      `basis "${basis}" asserts a number somebody produced, so amount_usd must be non-null (§3.9)`
    );
  }
  if (!isNullish(cost, "reason")) {
    add("cost.reason", "priced_basis_with_reason", `basis "${basis}" carries reason null (§3.9)`);
  }
  if (row.engine_surface === "ui") {
    // §5: "cost.basis vendor_reported or estimated on a row whose adapter made
    // no metered call (§3.9: that zero is ours, not the vendor's)". A browser
    // driving a public surface issues no metered request, so a UI row claiming
    // a vendor number is laundering our own inference as a measurement — the
    // exact mistake an earlier revision of §6.1 made.
    add(
      "cost.basis",
      "priced_basis_on_ui_surface",
      `basis "${basis}" on engine_surface "ui" claims a metered call that a browser probe did ` +
        'not make; use "no_charge" with reason ui_surface_no_metered_call (§3.9/§5)'
    );
  }
}

/** The conflict key `prompt_results` is UNIQUE on (migration 005). */
export function probeResultConflictKey(jobId, row) {
  return `${jobId}|${row.engine}|${row.query}`;
}

/**
 * Validate the whole ingest envelope.
 *
 * The v2 row (§3.1) names no `job_id` and no `brand`, and `prompt_results`
 * requires both, so the envelope carries them once for the batch rather than
 * being inferred per row. Inferring either would be the defaulting §5 forbids.
 *
 * @param {unknown} body the parsed request body
 * @returns {{ok: boolean, violations: Array<{index: number|null, field: string, code: string, detail: string}>}}
 */
export function validateIngestBody(body) {
  const violations = [];
  const add = (index, field, code, detail) => violations.push({ index, field, code, detail });

  if (!isPlainObject(body)) {
    add(null, "/", "not_an_object", "the request body must be a JSON object");
    return { ok: false, violations };
  }
  if (!isNonEmptyString(body.job_id)) {
    add(null, "job_id", "job_id_missing", "the scan_jobs id these results belong to is required");
  } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.job_id.trim())) {
    // prompt_results.job_id is a uuid column; a non-uuid is a 422 here rather
    // than a 500 from Postgres, and it is the caller's input that is wrong.
    add(null, "job_id", "job_id_not_a_uuid", "must be a uuid (prompt_results.job_id)");
  }
  if (!isNonEmptyString(body.brand)) {
    add(
      null,
      "brand",
      "brand_missing",
      "the resolveBrandKey() tenant key is required — prompt_results.brand is NOT NULL and " +
        "stores the domain-first key, never the display name (D7)"
    );
  }
  if (!Array.isArray(body.results)) {
    add(null, "results", "results_not_an_array", "must be an array of Probe Result v2 objects");
    return { ok: false, violations };
  }
  if (body.results.length === 0) {
    // An empty batch is accepted by nothing here: 200 on zero rows would be a
    // successful-looking ingest that stored nothing (standing rule 1).
    add(
      null,
      "results",
      "results_empty",
      "an empty batch is refused: a 200 that stored nothing is indistinguishable from a 200 " +
        "that stored a scan"
    );
    return { ok: false, violations };
  }

  const seen = new Map();
  body.results.forEach((row, index) => {
    const { violations: rowViolations } = validateProbeResult(row);
    for (const rv of rowViolations) add(index, rv.field, rv.code, rv.detail);

    // Two rows with the same conflict key in one body would upsert over each
    // other and the second would silently win — one row stored for two
    // measurements, with nothing saying so.
    if (isPlainObject(row) && typeof row.engine === "string" && typeof row.query === "string") {
      const key = probeResultConflictKey(String(body.job_id || ""), row);
      if (seen.has(key)) {
        add(
          index,
          "/",
          "duplicate_conflict_key",
          `duplicates (engine, query) from index ${seen.get(key)} in the same batch; the upsert ` +
            "conflict key is (job_id, engine, query), so one of the two would be silently lost"
        );
      } else {
        seen.set(key, index);
      }
    }
  });

  return { ok: violations.length === 0, violations };
}

/**
 * The four §3.7 evidence ids, as the `prompt_results` columns migration 021
 * added, plus the instant they were captured.
 *
 * A COLUMN NAME IS THE CONTRACT'S FIELD NAME with an `evidence_` prefix, so
 * this is a copy and not a translation: `evidence.screenshot_id` →
 * `evidence_screenshot_id`. §3.7 says the ids are opaque object keys in the
 * `probe-evidence` bucket, which is precisely what `createSignedUrl` takes, so
 * nothing here parses, joins or rewrites a path.
 *
 * MISSING IS NULL, AND NULL IS NOT "". A blank string in these columns would
 * render as a link to an object that does not exist, and the viewer could not
 * tell "no capture was taken" from "a capture was taken and we lost the key".
 * So anything that is not a non-empty string becomes null — including the
 * absent `evidence` object of a producer that predates v2.
 *
 * `evidence_captured_at` is `probed_at` (§3.1), and ONLY when at least one id
 * survived: a capture time on a row with no capture is a claim about something
 * that was never stored. It is stored as the ISO instant the fleet sent, not a
 * clock reading taken here.
 */
function promotedEvidence(row) {
  const evidence = isPlainObject(row?.evidence) ? row.evidence : null;
  const idOf = (field) => {
    const value = evidence ? evidence[field] : null;
    return isNonEmptyString(value) ? value.trim() : null;
  };
  const ids = {
    evidence_screenshot_id: idOf("screenshot_id"),
    evidence_dom_id: idOf("dom_id"),
    evidence_har_id: idOf("har_id"),
    evidence_raw_id: idOf("raw_id"),
  };
  const anyEvidence = Object.values(ids).some((value) => value !== null);
  return {
    ...ids,
    evidence_captured_at: anyEvidence && isNonEmptyString(row?.probed_at) ? row.probed_at : null,
  };
}

/**
 * Map a validated v2 result onto a `prompt_results` row (§2.4).
 *
 * The COMPLETE result goes into `raw` verbatim, which is what lets v2 fields
 * land with no migration — `state`, `state_reason`, `citations_state`,
 * `engine_surface`, `geo`, `timings`, `cost`, `attempt` and `probed_at` have no
 * promoted columns. `evidence` now does: migration 021 added the four §3.7 ids
 * and `evidence_captured_at` to `prompt_results` (R1.5.2), so R1.5.3 can select
 * a signable object key per answer row instead of digging through a jsonb blob.
 *
 * THE ONE MAPPING THAT MATTERS. `answered` is a nullable boolean, and the six
 * non-denominator states must NOT write `false` into it: `false` there is a
 * measured absence, and a blocked probe stored as a measured absence is
 * precisely the failure §1 of the contract exists to make unrepresentable. So
 * `answered` is `true` for `answered`, `false` for `no_answer` — the one state
 * that observed an absence — and `null` for the other six (§3.11).
 *
 * @param {{job_id: string, brand: string}} envelope
 * @param {object} row a result that has already passed validateProbeResult
 */
export function toPromptResultRow(envelope, row) {
  const answered = row.state === "answered";
  const measuredAbsence = row.state === "no_answer";
  const selfBrand = Array.isArray(row.brands) ? row.brands.find((b) => b && b.is_self) : null;
  const evidence = promotedEvidence(row);

  return {
    job_id: envelope.job_id,
    brand: envelope.brand,
    prompt_id: null,
    query: row.query,
    engine: row.engine,
    // true | false | null — never a coerced boolean. See the note above.
    answered: answered ? true : measuredAbsence ? false : null,
    mentioned: answered ? row.brand_mentioned_in_text : null,
    brand_cited: answered ? row.brand_cited : null,
    position: selfBrand ? selfBrand.position : null,
    sentiment: selfBrand ? selfBrand.sentiment : null,
    // v2 has no `intent` field; a value invented here would be a default.
    intent: null,
    // Not a §3.1 field. Passed through when the producer sends it, null — not
    // the column's DEFAULT false — when it does not, because "we do not know
    // whether this query was branded" must not read as "it was not".
    is_branded_query: typeof row.is_branded_query === "boolean" ? row.is_branded_query : null,
    answer_text: answered ? row.text : null,
    // Migration 021. Object keys in the private `probe-evidence` bucket, or
    // null — never "", never a path this function assembled.
    ...evidence,
    raw: row,
  };
}
