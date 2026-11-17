// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/project-context/services/ProjectContextService.ts
// Adapted for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOM_SECTION_KEY_PREFIX,
  PROJECT_CONTEXT_SECTION_KEYS,
  PROJECT_CONTEXT_SECTION_LABELS,
  RESEARCH_LOG_LIMIT,
  RESEARCH_LOG_RETENTION_DAYS,
  type ContextAuthor,
  type KeyPageRole,
  type ProjectCompetitorSource,
  type ProjectContext,
  type ProjectContextSectionKey,
  type ProjectContextUpdate,
  type ProjectResearchKind,
} from "../../shared/project-context.ts";
import { AppError } from "../../shared/http/appError.ts";
import { briefToOps, isSeededBrief } from "./briefImport.ts";
import { resolveContextUpdates, type ResolvedOp } from "./contextUpdateOps.ts";
import { createProjectContextRepository, type ProjectContextRepository } from "./repository.ts";

export type ProjectContextDeps = {
  repo?: ProjectContextRepository;
  now?: () => Date;
  /**
   * The `source` an `addCompetitors` update is stored with. The routes and the
   * resolver default to "manual"; the assistant tool passes "assistant".
   */
  competitorSource?: ProjectCompetitorSource;
};

export type WorkspaceBrand = {
  brandKey: string;
  display_name: string;
  website: string;
  website_host: string;
  aliases: string[];
};

function getRepo(admin: SupabaseClient, deps?: ProjectContextDeps): ProjectContextRepository {
  return deps?.repo ?? createProjectContextRepository(admin);
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateDaysBefore(date: Date, days: number): string {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return utcDate(new Date(day - days * 86_400_000));
}

export async function getProjectContext(
  admin: SupabaseClient,
  brand: WorkspaceBrand,
  deps?: ProjectContextDeps,
): Promise<ProjectContext> {
  const repo = getRepo(admin, deps);
  const [sectionRows, competitors, keyPages, researchRows] = await Promise.all([
    repo.listSections(brand.brandKey),
    repo.listCompetitors(brand.brandKey),
    repo.listKeyPages(brand.brandKey),
    repo.listResearchLog(brand.brandKey, RESEARCH_LOG_LIMIT + 1),
  ]);

  const stored = new Map(sectionRows.map((row) => [row.key, row]));
  const sections = PROJECT_CONTEXT_SECTION_KEYS.flatMap((key) => {
    const row = stored.get(key);
    return row
      ? [{
          key,
          content: row.content,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
          updatedByUser: row.updatedByUser,
        }]
      : [];
  });
  const limited = researchRows.length > RESEARCH_LOG_LIMIT;
  const researchLog = researchRows.slice(0, RESEARCH_LOG_LIMIT).map((row) => ({
    id: row.id,
    entryDate: row.entryDate,
    kind: row.kind,
    researchKey: row.researchKey,
    summary: row.summary,
    spendUsd: row.spendUsd,
    createdBy: row.createdBy,
  }));

  return {
    brandKey: brand.brandKey,
    sections,
    missingSections: PROJECT_CONTEXT_SECTION_KEYS.filter((key) => !stored.has(key)),
    customSections: sectionRows
      .filter((row) => row.key.startsWith(CUSTOM_SECTION_KEY_PREFIX))
      .map((row) => ({
        slug: row.key.slice(CUSTOM_SECTION_KEY_PREFIX.length),
        title: row.title,
        content: row.content,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        updatedByUser: row.updatedByUser,
      })),
    competitors,
    keyPages,
    researchLog,
    researchLogLimited: limited,
    brandIdentity: {
      displayName: brand.display_name,
      website: brand.website,
      matchNames: [...new Set([brand.display_name, ...brand.aliases])],
    },
  };
}

/**
 * The same read for a caller that holds only a brand key — F13's `cluster` step
 * and F22's turn prompt run inside jobs, where the context carries the key
 * alone. The brand row is read here rather than in the repository (§6.2.4 has no
 * brand read), so `getProjectContext` keeps one shape of input.
 */
export async function getProjectContextByKey(
  admin: SupabaseClient,
  brandKey: string,
  deps?: ProjectContextDeps,
): Promise<ProjectContext> {
  const { data, error } = await admin
    .from("customer_brands")
    .select("brand_key,display_name,website,website_host,aliases")
    .eq("brand_key", brandKey)
    .maybeSingle();
  if (error) {
    throw new AppError(503, "context_unavailable", "Context could not be loaded. Please retry.", { cause: error });
  }
  if (!data) throw new AppError(404, "workspace_not_found", "Workspace not found.");
  const row = data as Record<string, unknown>;
  const key = typeof row.brand_key === "string" && row.brand_key !== "" ? row.brand_key : brandKey;
  return getProjectContext(admin, {
    brandKey: key,
    display_name: typeof row.display_name === "string" ? row.display_name : key,
    website: typeof row.website === "string" ? row.website : "",
    website_host: typeof row.website_host === "string" ? row.website_host : "",
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === "string") : [],
  }, deps);
}

export async function applyContextUpdates(
  admin: SupabaseClient,
  brand: WorkspaceBrand,
  updates: ProjectContextUpdate[],
  author: ContextAuthor,
  actorUserId: string | null,
  deps?: ProjectContextDeps,
): Promise<ProjectContext> {
  const repo = getRepo(admin, deps);
  const [sectionRows, competitorRows, keyPageRows] = await Promise.all([
    repo.listSections(brand.brandKey),
    repo.listCompetitors(brand.brandKey),
    repo.listKeyPages(brand.brandKey),
  ]);
  const ops = resolveContextUpdates(
    updates,
    {
      customKeys: new Set(sectionRows.filter((row) => row.key.startsWith(CUSTOM_SECTION_KEY_PREFIX)).map((row) => row.key)),
      domains: new Set(competitorRows.map((row) => row.domain)),
      urls: new Set(keyPageRows.map((row) => row.url)),
      ownHost: brand.website_host.replace(/^www\./, ""),
    },
    { competitorSource: deps?.competitorSource ?? "manual" },
  );
  await repo.applyOps(brand.brandKey, ops, author, actorUserId);
  return getProjectContext(admin, brand, { ...deps, repo });
}

export async function applyResolvedOps(
  admin: SupabaseClient,
  brandKey: string,
  ops: ResolvedOp[],
  author: ContextAuthor,
  actorUserId: string | null,
  deps?: ProjectContextDeps,
): Promise<void> {
  await getRepo(admin, deps).applyOps(brandKey, ops, author, actorUserId);
}

export async function appendResearch(
  admin: SupabaseClient,
  input: {
    brandKey: string;
    kind: ProjectResearchKind;
    researchKey?: string;
    summary: string;
    spendUsd?: number | null;
    jobId?: string | null;
    author: ContextAuthor;
    actorUserId?: string | null;
  },
  deps?: ProjectContextDeps,
): Promise<void> {
  const [op] = resolveContextUpdates(
    [{ appendResearchLog: { summary: input.summary, kind: input.kind, researchKey: input.researchKey } }],
    { customKeys: new Set(), domains: new Set(), urls: new Set(), ownHost: "" },
  );
  if (op.kind !== "append_research_log") throw new Error("Expected append_research_log operation.");
  op.spend_usd = input.spendUsd ?? null;
  op.job_id = input.jobId ?? null;
  await getRepo(admin, deps).applyOps(input.brandKey, [op], input.author, input.actorUserId ?? null);
}

export async function findRecentResearch(
  admin: SupabaseClient,
  input: { brandKey: string; kind: ProjectResearchKind; researchKey: string; days?: number },
  deps?: ProjectContextDeps,
): Promise<{ id: string; entryDate: string; summary: string; spendUsd: number | null; createdAt: string } | null> {
  const now = deps?.now?.() ?? new Date();
  const since = dateDaysBefore(now, input.days ?? RESEARCH_LOG_RETENTION_DAYS);
  const researchKey = resolveContextUpdates(
    [{ appendResearchLog: { summary: "lookup", kind: input.kind, researchKey: input.researchKey } }],
    { customKeys: new Set(), domains: new Set(), urls: new Set(), ownHost: "" },
  )[0];
  if (researchKey.kind !== "append_research_log") throw new Error("Expected append_research_log operation.");
  if (researchKey.research_key === null) return null;
  const row = await getRepo(admin, deps).findRecentResearch(input.brandKey, input.kind, researchKey.research_key, since);
  if (!row) return null;
  return {
    id: row.id,
    entryDate: row.entryDate,
    summary: row.summary,
    spendUsd: row.spendUsd,
    createdAt: row.createdAt,
  };
}

export async function declaredCompetitors(
  admin: SupabaseClient,
  brandKey: string,
  deps?: ProjectContextDeps,
): Promise<{ domain: string; name: string | null; notes: string | null }[]> {
  const rows = await getRepo(admin, deps).listCompetitors(brandKey);
  return rows.map(({ domain, name, notes }) => ({ domain, name, notes }));
}

function pushSection(lines: string[], heading: string, body: string[]): void {
  lines.push(`## ${heading}`, "", ...(body.length > 0 ? body : ["_Empty_"]), "");
}

export function renderProjectContextMarkdown(context: ProjectContext): string {
  const lines = ["# Project context", ""];
  for (const key of PROJECT_CONTEXT_SECTION_KEYS) {
    const section = context.sections.find((entry) => entry.key === key);
    pushSection(lines, PROJECT_CONTEXT_SECTION_LABELS[key], section ? [section.content] : []);
  }

  for (const custom of context.customSections) {
    pushSection(lines, custom.title ?? custom.slug, [custom.content]);
  }
  pushSection(
    lines,
    "Competitors",
    context.competitors.map((competitor) => [
      `- ${competitor.domain}`,
      competitor.name ? ` — ${competitor.name}` : "",
      competitor.notes ? ` (${competitor.notes})` : "",
    ].join("")),
  );
  pushSection(
    lines,
    "Key pages",
    context.keyPages.map((page) => [
      `- ${page.url} — ${page.role}`,
      page.topic ? ` · ${page.topic}` : "",
      page.notes ? ` (${page.notes})` : "",
    ].join("")),
  );
  const researchHeading = context.researchLog.length === 0
    ? "Research log"
    : `Research log (${context.researchLog.length} ${context.researchLog.length === 1 ? "entry" : "entries"})`;
  pushSection(lines, researchHeading, [
    ...context.researchLog.map((entry) => `- ${entry.entryDate}: ${entry.summary} [id: ${entry.id}]`),
    ...(context.researchLogLimited
      ? ["", `_Older entries within the ${RESEARCH_LOG_RETENTION_DAYS}-day window are omitted._`]
      : []),
  ]);
  lines.push(context.missingSections.length > 0
    ? `Missing sections: ${context.missingSections.join(", ")}`
    : "Missing sections: none");
  return lines.join("\n");
}

function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : typeof err;
}

/**
 * §6.2.7 — imports a workspace's brand brief into memory exactly once.
 *
 * State is read first, so a completed read performs no claim and no write. A
 * missing or still-seeded brief is a successful no-op that leaves the checked
 * timestamp set (there is nothing to retry). Any failure after the claim is
 * released again so a later read can retry, and is logged by brand key only:
 * memory text must never reach a log line.
 *
 * Called by the GET handler only — `getProjectContext` stays pure, so F13–F17
 * and F22 read memory without ever triggering an import.
 */
export async function maybeImportBrandBrief(
  admin: SupabaseClient,
  brand: WorkspaceBrand,
  deps?: ProjectContextDeps,
): Promise<boolean> {
  const repo = getRepo(admin, deps);
  let claimed = false;
  try {
    const state = await repo.getBriefImportState(brand.brandKey);
    if (state.imported || state.checkedAt !== null) return false;
    if (!(await repo.claimBriefImport(brand.brandKey))) return false;
    claimed = true;

    const brief = await repo.getBrandBrief({
      brandKey: brand.brandKey,
      displayName: brand.display_name,
      aliases: brand.aliases,
    });
    if (!brief || isSeededBrief(brief, brand.brandKey, brand.display_name)) return false;

    const ops = briefToOps(brief, brand.website_host.replace(/^www\./, ""));
    // The RPC takes 1–60 resolved operations, so zero ops is never sent; the
    // import is still committed, because there is nothing left to retry.
    if (ops.length > 0) await repo.applyOps(brand.brandKey, ops, "system", null);
    await repo.markBriefImported(brand.brandKey);
    return true;
  } catch {
    console.error(`[project-context] brief import failed ${brand.brandKey}`);
    if (claimed) {
      try {
        await repo.releaseBriefImportClaim(brand.brandKey);
      } catch (releaseErr) {
        console.error(
          `[project-context] brief import claim release failed ${brand.brandKey}: ${describeFailure(releaseErr)}`,
        );
      }
    }
    return false;
  }
}
