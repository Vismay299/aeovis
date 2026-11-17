/**
 * F07 §6.2.7 — the one-time import of a workspace's brand brief into project
 * memory. Own code (the spec lists no upstream source for it): the two preset
 * shapes it recognises are the ones `src/shared/content/contentWorker.js` seeds.
 *
 * Both functions are pure. `maybeImportBrandBrief` in `service.ts` does the
 * claim/apply/mark dance around them.
 */

import { HEALTHCARE_CXO_BRIEF } from "../../shared/content/briefs/healthcareCxo.js";
import {
  CUSTOM_SECTION_KEY_PREFIX,
  MAX_KEY_PAGES,
  PROSE_MAX_CHARS,
} from "../../shared/project-context.ts";
import type { ProjectCompetitorSource } from "../../shared/project-context.ts";
import type { ResolvedOp } from "./contextUpdateOps.ts";
import { normalizeCompetitorDomain, normalizeKeyPageUrl } from "./normalize.ts";

/**
 * The generic preset `resolveBrief` persists on first use
 * (`contentWorker.js`: `tone_rules` there, verbatim). An edited brief carries
 * different rules, so the pair identifies the untouched preset.
 */
const GENERIC_TONE_RULES = [
  "Use clear, factual language.",
  "Do not invent product claims, prices, certifications or customer results.",
];

/** The generic preset's whole key set; any extra key means somebody edited it. */
const GENERIC_BRIEF_KEYS = ["one_liner", "tone_rules", "website"];

/**
 * Preset values are strings and arrays of strings, so JSON equality is exact.
 * Written out rather than left as a bare `JSON.stringify` call so the reason is
 * visible to the next reader.
 */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * True when the stored brief is still one of the two presets `resolveBrief`
 * seeds, i.e. there is nothing of the customer's in it to import.
 *
 * `displayName` is the optional third argument from GAP-04: the generic preset
 * is persisted with `one_liner: input?.brand_name || brand`, so a genuine
 * untouched preset routinely carries the display name rather than the brand key
 * and a brand-key-only check would report it as edited.
 */
export function isSeededBrief(
  brief: Record<string, unknown>,
  brandKey: string,
  displayName: string = brandKey,
): boolean {
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) return false;

  // (a) The healthcare preset, seeded with the brand key prefixed onto its
  // one-liner (`contentWorker.js`'s `legacyHealthcareSeed` rule). Every other
  // preset key must still deep-equal its shipped value.
  if (brief.one_liner === `${brandKey} — ${HEALTHCARE_CXO_BRIEF.one_liner}`) {
    const matchesPreset = Object.entries(HEALTHCARE_CXO_BRIEF).every(
      ([key, value]) => key === "one_liner" || sameJson(brief[key], value),
    );
    if (matchesPreset) return true;
  }

  // (b) The generic preset: exactly {one_liner, website, tone_rules}, with the
  // brand key or the display name as the one-liner and any website (the preset
  // stores whatever URL the content job was started with, including "").
  const keys = Object.keys(brief);
  if (keys.length !== GENERIC_BRIEF_KEYS.length) return false;
  if (GENERIC_BRIEF_KEYS.some((key) => !Object.hasOwn(brief, key))) return false;
  if (brief.one_liner !== brandKey && brief.one_liner !== displayName) return false;
  if (typeof brief.website !== "string") return false;
  return sameJson(brief.tone_rules, GENERIC_TONE_RULES);
}

function sectionLines(value: unknown, prefix: string): string {
  return stringList(value).map((entry) => `${prefix}${entry}`).join("\n").slice(0, PROSE_MAX_CHARS);
}

/**
 * Maps a non-seeded brand brief onto memory operations. Every section op is
 * `insert_section_if_missing` and every competitor op is
 * `insert_competitors_if_none`, so the import can never overwrite something the
 * customer already wrote; only key pages upsert, and only as `money`.
 */
export function briefToOps(brief: Record<string, unknown>, ownHost: string): ResolvedOp[] {
  const ops: ResolvedOp[] = [];
  const own = ownHost.trim().toLowerCase().replace(/^www\./, "");

  const oneLiner = typeof brief.one_liner === "string" ? brief.one_liner.trim() : "";
  const personas = stringList(brief.personas);
  const overview = [oneLiner, personas.length > 0 ? `Buyers: ${personas.join("; ")}` : ""]
    .filter((part) => part !== "")
    .join("\n\n");
  if (overview !== "") {
    ops.push({
      kind: "insert_section_if_missing",
      key: "business_overview",
      title: null,
      content: overview.slice(0, PROSE_MAX_CHARS),
    });
  }

  const writingPreferences = sectionLines(brief.tone_rules, "- ");
  if (writingPreferences !== "") {
    ops.push({
      kind: "insert_section_if_missing",
      key: "writing_preferences",
      title: null,
      content: writingPreferences,
    });
  }

  const priorityTopics = sectionLines(brief.priority_topics, "- ");
  if (priorityTopics !== "") {
    ops.push({
      kind: "insert_section_if_missing",
      key: `${CUSTOM_SECTION_KEY_PREFIX}priority-topics`,
      title: "Priority topics",
      content: priorityTopics,
    });
  }

  // A brief's competitors are free text; only domain-shaped strings become
  // rows, and a name without a domain is skipped rather than guessed at.
  const competitorRows: {
    domain: string;
    name: string | null;
    notes: string | null;
    source: ProjectCompetitorSource;
    source_url: string | null;
  }[] = [];
  for (const raw of stringList(brief.competitors)) {
    let domain: string;
    try {
      domain = normalizeCompetitorDomain(raw);
    } catch {
      continue;
    }
    if (domain === own) continue;
    if (competitorRows.some((row) => row.domain === domain)) continue;
    competitorRows.push({ domain, name: null, notes: null, source: "brief_import", source_url: null });
  }
  if (competitorRows.length > 0) {
    ops.push({ kind: "insert_competitors_if_none", rows: competitorRows });
  }

  const moneyPages: Extract<ResolvedOp, { kind: "upsert_key_pages" }>["rows"] = [];
  for (const raw of stringList(brief.money_pages)) {
    if (moneyPages.length >= MAX_KEY_PAGES) break;
    let url: string;
    try {
      url = normalizeKeyPageUrl(raw);
    } catch {
      continue;
    }
    if (moneyPages.some((row) => row.url === url)) continue;
    moneyPages.push({ url, role: "money", topic: null, notes: null });
  }
  if (moneyPages.length > 0) {
    ops.push({ kind: "upsert_key_pages", rows: moneyPages });
  }

  return ops;
}
