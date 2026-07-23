import { supabase } from "../db.js";

/**
 * Gets prompts for a given brand key from the database.
 *
 * Ordering is deterministic (created_at ASC, id ASC) — batch-inserted rows
 * share a timestamp, and the scan worker slices the first N, so a stable
 * tiebreaker is required for the tracked set to be identical across scans.
 *
 * @param {string} brand - Brand key (see resolveBrandKey) or legacy brand name
 * @param {boolean} includeDisabled - If true, returns disabled prompts as well
 * @param {{ strict?: boolean }} options - strict: throw on DB errors instead of
 *   returning []. Callers that must distinguish "no set yet" from "couldn't
 *   load the set" (the scan worker's fail-loud contract) pass strict: true.
 * @returns {Promise<Array>} List of prompt objects
 */
export async function getPromptsForBrand(brand, includeDisabled = false, options = {}) {
  const { strict = false } = options;

  if (!supabase) {
    if (strict) {
      // No DB configured at all — that's "no set exists", not a load failure.
      return [];
    }
    console.warn("Supabase client is not initialized.");
    return [];
  }

  try {
    let query = supabase
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
 * @param {string} brand - Brand name
 * @param {Array} prompts - List of prompts to save
 * @returns {Promise<Object>} { data, error }
 */
export async function upsertPrompts(brand, prompts) {
  if (!supabase) {
    return { error: new Error("Supabase client is not initialized.") };
  }

  try {
    // Load all existing prompts (including disabled) to preserve status and weight
    const existing = await getPromptsForBrand(brand, true);
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

    const { data, error } = await supabase
      .from("brand_prompts")
      .upsert(rows, { onConflict: "brand,text" });

    return { data, error };
  } catch (e) {
    return { error: e };
  }
}

/**
 * Updates a prompt's enabled status by ID.
 * Verifies that the row was actually found and updated.
 *
 * @param {string} id - The UUID of the prompt
 * @param {boolean} enabled - New status
 * @returns {Promise<boolean>} Success status (true if row updated)
 */
export async function updatePromptStatus(id, enabled) {
  if (!supabase) {
    return false;
  }

  try {
    const { data, error } = await supabase
      .from("brand_prompts")
      .update({ enabled })
      .eq("id", id)
      .select();

    if (error) {
      console.warn("Updating brand prompt status failed:", error.message);
      return false;
    }
    return data && data.length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Disables a prompt by ID (Legacy helper).
 *
 * @param {string} id - The UUID of the prompt
 * @returns {Promise<boolean>} Success status
 */
export async function disablePrompt(id) {
  return updatePromptStatus(id, false);
}
