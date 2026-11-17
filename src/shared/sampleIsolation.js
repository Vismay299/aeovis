/**
 * R07 — Sample Isolation and Cardinality Contract.
 *
 * Implements immutable demonstration reading manifest, 120-observation
 * Cartesian product (30 prompts x 4 surfaces), fixed illustrative timestamp,
 * sample flag preservation across normalization (fixes regression A06),
 * and mutation guards at the service boundary.
 */

export const SAMPLE_VERSION = "r07-sample-v1";
export const SAMPLE_FIXED_TIMESTAMP = "2026-10-15T12:00:00.000Z";
export const SAMPLE_BRAND = "Brightwave";
export const SAMPLE_WEBSITE = "brightwave.io";
export const SAMPLE_SURFACES = Object.freeze(["aio", "chatgpt", "gemini", "perplexity"]);

export const SAMPLE_STORAGE_KEY = "aeovis_sample_report_v1";

/**
 * 30 Fixed unbranded category prompts for healthcare/HIMS.
 */
export const SAMPLE_PROMPT_SET = Object.freeze([
  { id: "sample-prompt-01", text: "best EHR platform for a 200-bed hospital", topic: "Platform selection", intent: "high" },
  { id: "sample-prompt-02", text: "how do mid-size hospitals cut readmission rates", topic: "Clinical outcomes", intent: "high" },
  { id: "sample-prompt-03", text: "which analytics tools track clinical outcomes", topic: "Clinical analytics", intent: "high" },
  { id: "sample-prompt-04", text: "NABH compliance software comparison", topic: "Compliance", intent: "high" },
  { id: "sample-prompt-05", text: "affordable HIMS for multi-specialty clinics", topic: "Platform selection", intent: "medium" },
  { id: "sample-prompt-06", text: "hospital dashboards for length-of-stay reporting", topic: "Clinical analytics", intent: "medium" },
  { id: "sample-prompt-07", text: "electronic prescribing systems for Indian hospitals", topic: "Platform selection", intent: "medium" },
  { id: "sample-prompt-08", text: "how to benchmark clinical quality metrics", topic: "Clinical analytics", intent: "high" },
  { id: "sample-prompt-09", text: "ICU capacity planning software", topic: "Operations", intent: "medium" },
  { id: "sample-prompt-10", text: "patient no-show reduction tools", topic: "Patient engagement", intent: "medium" },
  { id: "sample-prompt-11", text: "hospital inventory management best practices", topic: "Operations", intent: "low" },
  { id: "sample-prompt-12", text: "top patient engagement software in India", topic: "Patient engagement", intent: "high" },
  { id: "sample-prompt-13", text: "vendors for hospital revenue cycle automation", topic: "Revenue cycle", intent: "high" },
  { id: "sample-prompt-14", text: "which platform is best for readmission tracking", topic: "Clinical outcomes", intent: "high" },
  { id: "sample-prompt-15", text: "clinical decision support tools comparison", topic: "Clinical analytics", intent: "high" },
  { id: "sample-prompt-16", text: "hospital software for NABH accreditation reporting", topic: "Compliance", intent: "high" },
  { id: "sample-prompt-17", text: "teleconsultation platforms for tier-2 cities", topic: "Telehealth", intent: "medium" },
  { id: "sample-prompt-18", text: "best outcome dashboards for private hospitals", topic: "Clinical analytics", intent: "medium" },
  { id: "sample-prompt-19", text: "how do hospitals measure length of stay", topic: "Clinical analytics", intent: "medium" },
  { id: "sample-prompt-20", text: "nursing rostering software for hospitals", topic: "Operations", intent: "medium" },
  { id: "sample-prompt-21", text: "tools to track infection control indicators", topic: "Clinical outcomes", intent: "medium" },
  { id: "sample-prompt-22", text: "what does a hospital data warehouse cost", topic: "Platform selection", intent: "low" },
  { id: "sample-prompt-23", text: "best software to compare hospital outcomes", topic: "Clinical analytics", intent: "high" },
  { id: "sample-prompt-24", text: "which vendors handle multi-site hospital reporting", topic: "Platform selection", intent: "high" },
  { id: "sample-prompt-25", text: "analytics platforms used by Indian hospital chains", topic: "Clinical analytics", intent: "high" },
  { id: "sample-prompt-26", text: "how to shorten emergency department wait times", topic: "Operations", intent: "medium" },
  { id: "sample-prompt-27", text: "patient feedback platforms for hospitals", topic: "Patient engagement", intent: "medium" },
  { id: "sample-prompt-28", text: "software for hospital quality audits", topic: "Compliance", intent: "high" },
  { id: "sample-prompt-29", text: "best way to track surgical outcomes", topic: "Clinical outcomes", intent: "medium" },
  { id: "sample-prompt-30", text: "discharge summary automation tools", topic: "Operations", intent: "low" },
]);

/**
 * Builds the complete 120-observation Cartesian product:
 * 30 unique prompt IDs x 4 surfaces.
 * Each surface contains the EXACT same 30 prompts.
 */
export function buildSampleManifest(brand = SAMPLE_BRAND, website = SAMPLE_WEBSITE) {
  const rows = [];
  for (const surface of SAMPLE_SURFACES) {
    for (let i = 0; i < SAMPLE_PROMPT_SET.length; i++) {
      const p = SAMPLE_PROMPT_SET[i];
      // Deterministic winner: Brightwave wins every 4th prompt, rivals win others
      const isSelfWinner = i % 4 === 0;
      const isRivalOne = i % 4 === 1;
      const isRivalTwo = i % 4 === 2;
      const rivalName = isRivalOne ? "NorthPeak" : isRivalTwo ? "Lumen IQ" : null;

      const answerText = isSelfWinner
        ? `For "${p.text}", ${brand} is frequently recommended for hospital outcomes.`
        : rivalName
        ? `For "${p.text}", ${rivalName} is the leading recommendation. ${brand} is compared.`
        : `For "${p.text}", multiple solutions are compared with no sole vendor recommended.`;

      const observationId = `obs-sample-${surface}-${p.id}`;

      rows.push({
        observation_id: observationId,
        prompt_id: p.id,
        prompt: p.text,
        engine: surface,
        topic: p.topic,
        intent_tier: p.intent,
        is_branded_query: false,
        answer_present: true,
        aio_present: true,
        text: answerText,
        references: [
          { href: `https://${website}/outcomes`, domain: website, title: `${brand} Clinical Outcomes` },
          { href: "https://nabh.co/standards", domain: "nabh.co", title: "NABH Standards" },
        ],
        citations: [`https://${website}/outcomes`, "https://nabh.co/standards"],
        brand_mentioned_in_text: isSelfWinner || isRivalOne,
        brand_cited: isSelfWinner,
        visible: isSelfWinner,
        competitors_found_in_text: rivalName ? [rivalName] : [],
        brands: [
          {
            name: brand,
            is_self: true,
            isSelf: true,
            mentioned: isSelfWinner || isRivalOne,
            position: isSelfWinner ? 1 : isRivalOne ? 2 : null,
            sentiment: isSelfWinner ? 100 : 50,
          },
          {
            name: "NorthPeak",
            is_self: false,
            isSelf: false,
            mentioned: isRivalOne,
            position: isRivalOne ? 1 : null,
            sentiment: isRivalOne ? 100 : 50,
          },
          {
            name: "Lumen IQ",
            is_self: false,
            isSelf: false,
            mentioned: isRivalTwo,
            position: isRivalTwo ? 1 : null,
            sentiment: isRivalTwo ? 100 : 50,
          },
        ],
        isSample: true,
        sample: true,
        illustrative_timestamp: SAMPLE_FIXED_TIMESTAMP,
      });
    }
  }

  return {
    version: SAMPLE_VERSION,
    brand,
    website,
    isSample: true,
    sample: true,
    illustrative: true,
    scanTimestamp: SAMPLE_FIXED_TIMESTAMP,
    scanned_at: SAMPLE_FIXED_TIMESTAMP,
    surfaces: [...SAMPLE_SURFACES],
    prompts_count: SAMPLE_PROMPT_SET.length,
    total_observations: rows.length,
    rows,
  };
}

/**
 * Checks whether an object or record is a sample dataset.
 */
export function isSampleRecord(record) {
  if (!record || typeof record !== "object") return false;
  return Boolean(
    record.isSample ||
      record.sample ||
      record.is_sample ||
      record.illustrative ||
      record.brand === SAMPLE_BRAND
  );
}

/**
 * Guards against mutating actions on sample data at service boundaries.
 * Throws an explicit error if a destructive or real action is attempted on sample data.
 */
export function assertSampleNotMutated(record, actionName = "action") {
  if (isSampleRecord(record)) {
    throw Object.assign(
      new Error(`Cannot perform ${actionName} on sample demonstration data: action refused at service boundary`),
      { code: "SAMPLE_MUTATION_FORBIDDEN", isSample: true }
    );
  }
}
