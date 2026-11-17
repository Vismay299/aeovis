// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/ai-visibility-results.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type ExecutionBrandFact = {
  name: string;
  isSelf: boolean;
  mentioned: boolean | null;
};

export type ExecutionFacts = {
  status: string;
  source: "scan" | "explore" | "legacy";
  brands: ExecutionBrandFact[];
  ownMentioned: boolean | null;
  ownCited: boolean | null;
  competitorsCited: string[] | null;
  selfName: string;
  mentionState?: string | null;
};

export type BrandSummary = {
  name: string;
  isSelf: boolean;
  answers: number;
  mentions: number;
  unknown: number;
  citations: number;
};

function normalizeName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function competitorCitesBrand(competitorsCited: string[] | null, brandName: string): boolean {
  if (!Array.isArray(competitorsCited)) return false;
  const wanted = normalizeName(brandName);
  if (!wanted) return false;
  return competitorsCited.some((entry) => normalizeName(entry) === wanted);
}

/**
 * F12 §6.2 — brand rates over answered scan + legacy answers.
 * Explore rows are listed but never counted. Unknown mention states are
 * excluded from the denominator. Self is first, then mentions desc,
 * citations desc, name asc.
 */
export function summarizeBrands(rows: ExecutionFacts[]): BrandSummary[] {
  const summaries = new Map<string, BrandSummary & { key: string }>();
  const selfKey = "self";

  const ensureSelf = (displayName: string): BrandSummary & { key: string } => {
    let summary = summaries.get(selfKey);
    if (!summary) {
      summary = { key: selfKey, name: displayName, isSelf: true, answers: 0, mentions: 0, unknown: 0, citations: 0 };
      summaries.set(selfKey, summary);
    } else if (!summary.name && displayName) {
      summary.name = displayName;
    }
    return summary;
  };

  for (const row of rows) {
    if (row.source === "explore") continue;
    if (row.status !== "answered") continue;
    const selfDisplay = String(row.selfName || "").trim() || "Your brand";
    const roster: ExecutionBrandFact[] =
      Array.isArray(row.brands) && row.brands.length > 0
        ? row.brands
        : [{ name: selfDisplay, isSelf: true, mentioned: row.ownMentioned ?? null }];

    const seenSelf = roster.some((brand) => brand.isSelf);
    if (!seenSelf) {
      roster.push({ name: selfDisplay, isSelf: true, mentioned: row.ownMentioned ?? null });
    }

    for (const brand of roster) {
      if (brand.isSelf) {
        const summary = ensureSelf(String(brand.name || selfDisplay));
        const mentionState = row.mentionState ?? null;
        const mentioned = brand.mentioned;
        if (mentioned === null || (mentionState !== null && mentionState !== "observed")) {
          if (mentioned === null || mentionState !== "observed") {
            if (mentioned === null) {
              summary.unknown += 1;
              continue;
            }
            if (mentionState !== undefined && mentionState !== null && mentionState !== "observed") {
              summary.unknown += 1;
              continue;
            }
          }
        }
        if (mentioned === null) {
          summary.unknown += 1;
          continue;
        }
        summary.answers += 1;
        if (mentioned) summary.mentions += 1;
        if (row.ownCited === true) summary.citations += 1;
        continue;
      }
      const name = String(brand.name || "").trim();
      if (!name) continue;
      const key = `brand:${normalizeName(name)}`;
      let summary = summaries.get(key);
      if (!summary) {
        summary = { key, name, isSelf: false, answers: 0, mentions: 0, unknown: 0, citations: 0 };
        summaries.set(key, summary);
      }
      if (brand.mentioned === null) {
        summary.unknown += 1;
        continue;
      }
      summary.answers += 1;
      if (brand.mentioned) summary.mentions += 1;
      if (competitorCitesBrand(row.competitorsCited, name)) summary.citations += 1;
    }
  }

  const values = [...summaries.values()];
  values.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (b.mentions !== a.mentions) return b.mentions - a.mentions;
    if (b.citations !== a.citations) return b.citations - a.citations;
    return a.name.localeCompare(b.name);
  });
  return values.map(({ name, isSelf, answers, mentions, unknown, citations }) => ({
    name,
    isSelf,
    answers,
    mentions,
    unknown,
    citations,
  }));
}
