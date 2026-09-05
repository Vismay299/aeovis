import { supabase } from "../db.js";

/**
 * Raised when a brand_prompts WRITE could not be performed.
 *
 * `code` separates the two remedies an operator actually has, because they are
 * different problems: "db_not_configured" means this deployment has no Supabase
 * credentials (fix the env vars — nothing was ever going to persist), while
 * "db_write_failed" means the database itself refused or could not receive the
 * statement (fix the database, or retry).
 *
 * Deliberately the same two code strings as ScanWriteError / ScansUnavailableError
 * in ../db.js (R2.8.6 / R2.8.4): one vocabulary for "the database did not do the
 * thing". A separate class for the same reason ScanWriteError is separate from
 * ScansUnavailableError — a handler catching one kind of failure must not
 * accidentally swallow another kind.
 */
export class PromptWriteError extends Error {
  constructor(message, { cause, code = "prompt_write_failed" } = {}) {
    super(message);
    this.name = "PromptWriteError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Test-only client injection, matching the `deps.client` convention used by
 * every helper in ../db.js and ./content.js. Real call sites never pass a
 * client, so this always resolves to the module-level `supabase`. The
 * hasOwnProperty check means an explicit `{ client: undefined }` is a
 * deliberate "there is no client" — it cannot fall through to the ambient one
 * and touch a real database from a test.
 */
function resolveClient(deps) {
  return deps && Object.prototype.hasOwnProperty.call(deps, "client") ? deps.client : supabase;
}

/**
 * Gets prompts for a given brand key from the database.
 *
 * Ordering is deterministic (created_at ASC, id ASC) — batch-inserted rows
 * share a timestamp, and the scan worker slices the first N, so a stable
 * tiebreaker is required for the tracked set to be identical across scans.
 *
 * @param {string} brand - Brand key (see resolveBrandKey) or legacy brand name
 * @param {boolean} includeDisabled - If true, returns disabled prompts as well
 * @param {{ strict?: boolean, client?: object }} options - strict: throw on DB
 *   errors instead of returning []. Callers that must distinguish "no set yet"
 *   from "couldn't load the set" (the scan worker's fail-loud contract) pass
 *   strict: true. `client` is test-only injection (see resolveClient).
 * @returns {Promise<Array>} List of prompt objects
 */
export async function getPromptsForBrand(brand, includeDisabled = false, options = {}) {
  const { strict = false } = options;
  const client = resolveClient(options);

  if (!client) {
    if (strict) {
      // No DB configured at all — that's "no set exists", not a load failure.
      return [];
    }
    console.warn("Supabase client is not initialized.");
    return [];
  }

  try {
    let query = client
      .from("brand_prompts")
      .select("*")
      .eq("brand", brand);

    if (!includeDisabled) {
      query = query.eq("enabled", true);
    }

    const { data, error } = await query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

    if (error) {
      if (strict) {
        throw new Error(`brand_prompts fetch failed: ${error.message}`);
      }
      console.warn("Error fetching brand prompts (falling back to empty):", error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    if (strict) throw e;
    return [];
  }
}

/**
 * Upserts a list of prompts for a brand.
 * Preserves the enabled status and custom weight of existing prompt conflicts.
 *
 * CONTRACT (R2.2.3 / finding B5): this either performs the write and returns
 * what the database gave back, or it THROWS a PromptWriteError. It never
 * resolves with a failure inside the value.
 *
 * It used to be the last `return { error }` helper in the whole db surface:
 * `{ error: new Error(...) }` with no client, `{ data, error }` from PostgREST,
 * and `{ error: e }` from its own catch. Standing rule 2 — never fail-soft a
 * create call — and the reason the rule exists is visible at the two worker
 * call sites. scanWorker's runSourcingPhase wraps this call in a try/catch that
 * counts the swallow (errors_recovered) and NAMES it (skip reason
 * prompt_persist_failed); sourceUnbrandedQueries' legacy-migration path wraps
 * it in a catch that ABORTS the scan to protect score comparability. Neither
 * catch could ever fire, because a returned object is not a thrown error: a
 * scan whose prompts were never persisted reported a clean sourcing phase with
 * skips_total 0, and the next scan re-generated a different prompt set and
 * compared the score against it.
 *
 * Throwing rather than returning a discriminated union, for the reason
 * getScansForBrand (R2.8.4) and insertScan (R2.8.6) throw: a union a caller
 * forgot to unwrap degrades back into exactly the silence this removes.
 *
 * The resolved value keeps `{ data, error }` ONLY so the one destructuring
 * caller (POST /api/brands/[brand]/prompts) keeps working untouched. `error` on
 * that path is ALWAYS null — a real error has already been thrown.
 *
 * NOTE on `data`: the upsert deliberately does not `.select()`, so PostgREST
 * resolves `data: null` on SUCCESS (see ../db.js insertScan's cascade-3 note).
 * No caller reads `data`, and success/failure here is decided by the error
 * envelope, not by the row count — but nobody may start treating a null `data`
 * as "nothing was written" without adding `.select()` first.
 *
 * @param {string} brand - Brand name
 * @param {Array} prompts - List of prompts to save
 * @param {{ client?: object }} deps - test-only client injection
 * @returns {Promise<{data: Array|null, error: null}>}
 * @throws {PromptWriteError} code db_not_configured | db_write_failed
 */
export async function upsertPrompts(brand, prompts, deps = {}) {
  const client = resolveClient(deps);

  if (!client) {
    throw new PromptWriteError(
      `Cannot save the prompt set for "${brand}": this deployment has no Supabase client ` +
        `(NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Nothing was written.`,
      { code: "db_not_configured" }
    );
  }

  // Load all existing prompts (including disabled) to preserve status and weight.
  //
  // strict: true is load-bearing, not defensive. This read decides whether a
  // conflicting row keeps its enabled flag and custom weight. Fail-quiet (the
  // default) returns [] on a transient DB error, and every row then upserts with
  // the CALLER's defaults — enabled: true, weight: 1.0 — so a prompt the user
  // deliberately disabled comes back on, and a hand-tuned weight is reset, with
  // no error anywhere. A silent write of the WRONG values is worse than a
  // failed write.
  let existing;
  try {
    existing = await getPromptsForBrand(brand, true, { strict: true, client });
  } catch (e) {
    throw new PromptWriteError(
      `Cannot save the prompt set for "${brand}": reading the existing set first failed ` +
        `(${e && e.message ? e.message : String(e)}). Nothing was written — writing without ` +
        `it would have reset every disabled flag and custom weight.`,
      { code: "db_write_failed", cause: e }
    );
  }

  const existingMap = new Map(existing.map(e => [e.text.toLowerCase().trim(), e]));

  const rows = prompts.map(p => {
    const textKey = p.text.toLowerCase().trim();
    const found = existingMap.get(textKey);
    const isEnabled = found ? found.enabled : (p.enabled !== false);
    const weightVal = found ? found.weight : (p.weight ?? null);
    const sourceVal = found ? (found.source || "llm_generated") : (p.source || "llm_generated");

    return {
      brand,
      text: p.text,
      intent_tier: p.intent_tier,
      topic: p.topic || "General",
      weight: weightVal,
      enabled: isEnabled,
      source: sourceVal
    };
  });

  // The try wraps ONLY the statement itself. A malformed `prompts` argument is a
  // caller bug, not a database failure, and dressing a TypeError up as
  // db_write_failed would send an operator to look at a healthy database.
  let res;
  try {
    res = await client.from("brand_prompts").upsert(rows, { onConflict: "brand,text" });
  } catch (e) {
    throw new PromptWriteError(
      `Saving ${rows.length} prompt(s) for "${brand}" failed: ${e && e.message ? e.message : String(e)}`,
      { code: "db_write_failed", cause: e }
    );
  }

  if (res.error) {
    throw new PromptWriteError(
      `Saving ${rows.length} prompt(s) for "${brand}" failed: ${res.error.message}`,
      { code: "db_write_failed", cause: res.error }
    );
  }

  return { data: res.data, error: null };
}

/**
 * Updates a prompt's enabled status by ID.
 *
 * The boolean return now means exactly ONE thing: did a row with this id exist
 * and get updated. It used to mean three — no client, DB error, and row not
 * found all collapsed to `false`, and its only caller
 * (PATCH /api/prompts/[id]) maps `false` to 404 "Prompt not found or update
 * failed". So a database outage told the user their prompt did not exist,
 * which is the read-side lie R2.8.4 killed, arriving on the write side. Both
 * failures now throw and the route's own catch turns them into a 500; a
 * genuinely absent row still returns false and still 404s.
 *
 * @param {string} id - The UUID of the prompt
 * @param {boolean} enabled - New status
 * @param {{ client?: object }} deps - test-only client injection
 * @returns {Promise<boolean>} true if a row was found and updated, false if no
 *   such row exists
 * @throws {PromptWriteError} code db_not_configured | db_write_failed
 */
export async function updatePromptStatus(id, enabled, deps = {}) {
  const client = resolveClient(deps);

  if (!client) {
    throw new PromptWriteError(
      `Cannot change prompt ${id}: this deployment has no Supabase client ` +
        `(NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Nothing was written.`,
      { code: "db_not_configured" }
    );
  }

  let data;
  try {
    const res = await client
      .from("brand_prompts")
      .update({ enabled })
      .eq("id", id)
      .select();
    if (res.error) {
      throw new PromptWriteError(
        `Updating prompt ${id} failed: ${res.error.message}`,
        { code: "db_write_failed", cause: res.error }
      );
    }
    data = res.data;
  } catch (e) {
    if (e instanceof PromptWriteError) throw e;
    throw new PromptWriteError(
      `Updating prompt ${id} failed: ${e && e.message ? e.message : String(e)}`,
      { code: "db_write_failed", cause: e }
    );
  }

  // The DB answered. An empty result here is a real measurement — no row
  // carries this id — and is the only thing `false` is allowed to mean.
  return !!data && data.length > 0;
}

/**
 * Disables a prompt by ID (Legacy helper).
 *
 * Inherits updatePromptStatus's contract: throws PromptWriteError on a failed
 * write, returns false only for a genuinely absent row.
 *
 * @param {string} id - The UUID of the prompt
 * @param {{ client?: object }} deps - test-only client injection
 * @returns {Promise<boolean>} true if a row was found and updated
 */
export async function disablePrompt(id, deps = {}) {
  return updatePromptStatus(id, false, deps);
}
