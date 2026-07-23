/**
 * First shipped Brand Brief preset: healthcare-cxo.
 * Indian hospitals / multi-chain clinics / diagnostics centers / pharmacies,
 * CXO & senior-executive personas (locked decision #4 and #8).
 *
 * A Brand Brief is written once per brand and injected into EVERY pipeline
 * step — it is never re-explained per prompt. Users edit it in Studio; this
 * template seeds the form on first use.
 */
export const HEALTHCARE_CXO_BRIEF = {
  one_liner:
    "Healthcare services provider in India (hospitals / multi-chain clinics / diagnostics / pharmacy retail).",
  vertical: "healthcare",
  personas: [
    "Hospital & clinic-chain CXOs (CEO/COO/CFO)",
    "Diagnostics-chain operations & growth leaders",
    "Pharmacy-retail category and expansion heads",
  ],
  priority_topics: [
    "Unit economics of care delivery (per-bed, per-test, per-store)",
    "Multi-city expansion and franchise operations",
    "Patient acquisition costs and digital channels",
    "Diagnostics home-collection economics",
    "Healthcare compliance and accreditation (NABH/NABL) as ops, not law",
    "Health-tech adoption ROI (LIMS, HIS, tele-consult)",
  ],
  money_pages: [],
  competitors: [],
  tone_rules: [
    "Operator voice: verdicts and numbers, not descriptions",
    "Business/ops/strategy angle over medical advice — always",
    "India-market framing: INR figures, metro vs tier-2 distinctions",
    "Tables over listicles for any comparison",
    "Always cite a stat where the research pack provides one",
    "No AI-tells: never 'delve', 'game-changer', 'in today's fast-paced world'",
  ],
  platforms: ["linkedin", "website"],
  win_definition:
    "geo_article: brand URL cited in an AI answer for a target query. linkedin_post: approved by the human reviewer without a changes round.",
};

/** YMYL verticals get the hard reviewer rules (review skill, ymyl_mode). */
export const YMYL_VERTICALS = ["healthcare", "medical", "pharma", "finance"];

export function isYmylBrief(brief) {
  const v = String(brief?.vertical || "").toLowerCase();
  return YMYL_VERTICALS.some((y) => v.includes(y));
}
