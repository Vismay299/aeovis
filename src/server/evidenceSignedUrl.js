/**
 * R1.5.3 — one signed, short-lived URL for one stored probe artefact.
 *
 * The `probe-evidence` bucket (R1.5.1, migration 019) is PRIVATE: nothing in it
 * is reachable without a signature. `prompt_results.evidence_*_id` (R1.5.2,
 * migration 021) holds the object keys — §3.7 of docs/contracts/probe-result.md
 * says those ids ARE the keys, so nothing here parses, joins or assembles a
 * path. The only key this module will ever sign is one it read out of a
 * `prompt_results` row that the caller reached by (job_id, result id).
 *
 * THAT IS THE WHOLE SECURITY MODEL, so it is stated plainly: a caller cannot
 * name an object. It names a scan job and a result row; the key comes from the
 * row. A caller who guesses an object key gets nothing, because no code path
 * passes a caller-supplied string to `createSignedUrl`.
 *
 * ABSENT IS NOT AN ERROR AND IT IS NOT A URL. A row whose `evidence_*_id` is
 * NULL means no capture was stored for that answer (today: every row — no
 * adapter posts evidence yet, R1.3 is unbuilt). That answers `evidence_absent`,
 * which the route turns into a 404 with a sentence. It never fabricates a key
 * from the job id and the engine, and it never signs "".
 */

import { supabase } from "./db.js";
import { EVIDENCE_BUCKET } from "./evidenceRetention.js";

/**
 * How long a signed evidence URL lives, in seconds. THE one place this number
 * is written; the route, the docs section and the tests all read it from here.
 *
 * 120 s, at the short end of the 60–300 s band, because the URL has exactly one
 * job: carry a click from the dashboard to the browser's next navigation. It is
 * not a share link and must not survive being pasted into Slack. Two minutes
 * absorbs a slow render or a redirect on a bad connection and nothing more.
 * Raising it makes a leaked URL useful for longer; lowering it past ~60 s starts
 * breaking real, slow clients.
 */
export const EVIDENCE_SIGNED_URL_TTL_SECONDS = 120;

/**
 * The artefact kinds, and the `prompt_results` column that stores each one's
 * object key. A kind that is not a key of this map is a 400 — never a guessed
 * column name, never a key built by string concatenation.
 */
export const EVIDENCE_KIND_COLUMNS = Object.freeze({
  screenshot: "evidence_screenshot_id",
  dom: "evidence_dom_id",
  har: "evidence_har_id",
  raw: "evidence_raw_id",
});

export const EVIDENCE_KINDS = Object.freeze(Object.keys(EVIDENCE_KIND_COLUMNS));

export const EVIDENCE_SIGN_REASONS = Object.freeze({
  BAD_KIND: "bad_kind",
  BAD_REQUEST: "bad_request",
  NOT_CONFIGURED: "not_configured",
  LOOKUP_FAILED: "lookup_failed",
  RESULT_NOT_FOUND: "result_not_found",
  EVIDENCE_ABSENT: "evidence_absent",
  SIGN_FAILED: "sign_failed",
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECTED_COLUMNS = ["id", "job_id", ...Object.values(EVIDENCE_KIND_COLUMNS), "evidence_captured_at"].join(", ");

function refusal(status, reason, detail) {
  return { ok: false, status, reason, detail };
}

/**
 * Sign the stored artefact of one prompt result.
 *
 * @param {{jobId: string, resultId: string, kind: string}} request
 * @param {{client?: object, storage?: object, ttlSeconds?: number}} deps
 *   `storage` is a bucket handle (`client.storage.from(EVIDENCE_BUCKET)`) and is
 *   the injection seam the route tests drive.
 * @returns {Promise<{ok: true, url: string, key: string, kind: string,
 *   expiresInSeconds: number, capturedAt: string|null} | {ok: false, status: number,
 *   reason: string, detail: string}>}
 */
export async function signEvidenceForResult({ jobId, resultId, kind }, deps = {}) {
  const ttlSeconds = deps.ttlSeconds ?? EVIDENCE_SIGNED_URL_TTL_SECONDS;

  if (!Object.prototype.hasOwnProperty.call(EVIDENCE_KIND_COLUMNS, kind)) {
    return refusal(
      400,
      EVIDENCE_SIGN_REASONS.BAD_KIND,
      `Unknown evidence kind "${kind}". Known kinds: ${EVIDENCE_KINDS.join(", ")}.`
    );
  }
  const column = EVIDENCE_KIND_COLUMNS[kind];

  if (typeof jobId !== "string" || !jobId) {
    return refusal(400, EVIDENCE_SIGN_REASONS.BAD_REQUEST, "A job id is required.");
  }
  if (typeof resultId !== "string" || !resultId) {
    return refusal(400, EVIDENCE_SIGN_REASONS.BAD_REQUEST, "A result id is required (?result=<uuid>).");
  }
  // `prompt_results.id` is a uuid (migration 005). A malformed id cannot match a
  // row, so it is the same answer as a row that does not exist — and refusing it
  // here keeps a 22P02 cast error out of the lookup, where it would have been
  // reported as "lookup failed" (a 502) rather than "no such result" (a 404).
  if (!UUID_RE.test(resultId)) {
    return refusal(
      404,
      EVIDENCE_SIGN_REASONS.RESULT_NOT_FOUND,
      "No such result for this scan job."
    );
  }

  const client = deps.client ?? supabase;
  const storage = deps.storage ?? (client ? client.storage.from(EVIDENCE_BUCKET) : null);
  if (!client || !storage) {
    // Rule 1: a path that cannot look anything up says so. "Not configured" is
    // not "this answer has no screenshot".
    return refusal(
      503,
      EVIDENCE_SIGN_REASONS.NOT_CONFIGURED,
      "Evidence storage is not configured on this deployment, so nothing could be looked up. " +
        "This is not a statement that the answer has no evidence."
    );
  }

  const { data, error } = await client
    .from("prompt_results")
    .select(SELECTED_COLUMNS)
    .eq("id", resultId)
    // The scoping check. A result id alone is not enough: it must belong to the
    // job in the path, which is the job the caller already reached.
    .eq("job_id", jobId)
    .limit(1);

  if (error) {
    // Never fail-soft into "no evidence": an unreadable row is unknown.
    return refusal(
      502,
      EVIDENCE_SIGN_REASONS.LOOKUP_FAILED,
      `The result row could not be read, so it is unknown whether evidence exists: ${error.message || String(error)}`
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return refusal(404, EVIDENCE_SIGN_REASONS.RESULT_NOT_FOUND, "No such result for this scan job.");
  }

  const key = typeof row[column] === "string" ? row[column].trim() : "";
  if (!key) {
    return refusal(
      404,
      EVIDENCE_SIGN_REASONS.EVIDENCE_ABSENT,
      `This answer has no stored ${kind}. No capture was recorded for it — there is nothing to show, ` +
        "and no URL is invented in its place."
    );
  }

  const { data: signed, error: signError } = await storage.createSignedUrl(key, ttlSeconds);
  if (signError || !signed?.signedUrl) {
    return refusal(
      502,
      EVIDENCE_SIGN_REASONS.SIGN_FAILED,
      `The stored ${kind} could not be signed: ${signError?.message || "Storage returned no signed URL."}`
    );
  }

  return {
    ok: true,
    url: signed.signedUrl,
    key,
    kind,
    expiresInSeconds: ttlSeconds,
    capturedAt: row.evidence_captured_at ?? null,
  };
}
