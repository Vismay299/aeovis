import { createHash } from "node:crypto";
import { SKILL_MANIFEST } from "./manifest.generated.ts";
import type { SkillManifestEntry } from "./types.ts";

export const PERCEEV_SURFACE_NOTE = `> Surface note: you are the Perceev assistant inside the Perceev app. You are signed in and scoped to the
> user's current workspace; never ask which workspace. You have no filesystem. Workspace memory is in your
> context. Paid tools show the user a price card and run only after they approve it; tools that act outside
> Perceev show a confirm card with no price and run only after they confirm it. If a step needs a tool
> you do not have, say so in one line and point the user at the app page instead of improvising.`;

export type SkillSummary = { name: string; title: string; description: string; version: string };
export type LoadedSkill = SkillSummary & { body: string; tools: string[]; optionalTools: string[] };

type Input = {
  availableTools: ReadonlySet<string>;
  enabled: boolean;
  flags?: Record<string, boolean>;
};

type Deps = { manifest?: readonly SkillManifestEntry[] };

// A skill with requires_flags is hidden unless every named flag is explicitly true. When the caller
// passes no flags object at all, that counts as no flag being true, so a flagged skill stays hidden.
function visible(entry: SkillManifestEntry, input: Input): boolean {
  if (entry.internal) return false;
  if (!entry.tools.every((tool) => input.availableTools.has(tool))) return false;
  return entry.requiresFlags.every((flag) => input.flags?.[flag] === true);
}

function summarise(entry: SkillManifestEntry): SkillSummary {
  return { name: entry.name, title: entry.title, description: entry.description, version: entry.version };
}

export function listSkills(input: Input, deps?: Deps): SkillSummary[] {
  if (!input.enabled) return [];
  const manifest = deps?.manifest ?? SKILL_MANIFEST;
  return manifest
    .filter((entry) => visible(entry, input))
    .map(summarise)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function loadSkill(name: string, input: Input, deps?: Deps): LoadedSkill | null {
  if (!input.enabled) return null;
  const manifest = deps?.manifest ?? SKILL_MANIFEST;
  const entry = manifest.find((candidate) => candidate.name === name);
  if (!entry || !visible(entry, input)) return null;
  return {
    ...summarise(entry),
    body: `${PERCEEV_SURFACE_NOTE}\n\n${entry.body}`,
    tools: entry.tools,
    optionalTools: entry.optionalTools,
  };
}

/**
 * The version of a skill by name, whatever its visibility. F23 records it on a saved report, so a
 * report made by a skill keeps that version even if the skill is later hidden or edited.
 */
export function getSkillVersion(name: string, deps?: Deps): string | null {
  const manifest = deps?.manifest ?? SKILL_MANIFEST;
  return manifest.find((candidate) => candidate.name === name)?.version ?? null;
}

export function skillCatalogFingerprint(summaries: readonly SkillSummary[]): string {
  const material = summaries.map((summary) => `${summary.name}@${summary.version}`).join("\n");
  return createHash("sha256").update(material).digest("hex");
}
