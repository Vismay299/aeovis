// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/project-context/repositories/ProjectContextRepository.ts
// Adapted for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";
import type { ContextAuthor, KeyPageRole, ProjectCompetitorSource } from "../../shared/project-context.ts";
import type { ResolvedOp } from "./contextUpdateOps.ts";

export type SectionRow = {
  key: string;
  title: string | null;
  content: string;
  updatedAt: string;
  updatedBy: ContextAuthor;
  updatedByUser: string | null;
};

export type CompetitorRow = {
  id: string;
  domain: string;
  name: string | null;
  notes: string | null;
  source: ProjectCompetitorSource;
  sourceUrl: string | null;
  updatedAt: string;
  updatedBy: ContextAuthor;
  updatedByUser: string | null;
};

export type KeyPageRow = {
  id: string;
  url: string;
  role: KeyPageRole;
  topic: string | null;
  notes: string | null;
  updatedAt: string;
  updatedBy: ContextAuthor;
  updatedByUser: string | null;
};

export type ResearchRow = {
  id: string;
  entryDate: string;
  kind: string;
  researchKey: string | null;
  summary: string;
  spendUsd: number | null;
  jobId: string | null;
  createdBy: ContextAuthor;
  createdByUser: string | null;
  createdAt: string;
};

/**
 * The identity a stored `brand_briefs` row may be keyed by. Legacy rows use the
 * display name or one of the workspace's aliases (§11 risk 8), so the lookup
 * tries all three — exact matches only, in this order.
 */
export type BrandBriefLookup = { brandKey: string; displayName: string; aliases: string[] };

/** `brand_key`, then `display_name`, then each alias, exact and de-duplicated. */
export function brandBriefCandidates(brand: BrandBriefLookup): string[] {
  const candidates = [brand.brandKey, brand.displayName, ...(brand.aliases ?? [])];
  return [...new Set(candidates.filter((value): value is string => typeof value === "string" && value !== ""))];
}

export type ProjectContextRepository = {
  listSections(brandKey: string): Promise<SectionRow[]>;
  listCompetitors(brandKey: string): Promise<CompetitorRow[]>;
  listKeyPages(brandKey: string): Promise<KeyPageRow[]>;
  listResearchLog(brandKey: string, limit: number): Promise<ResearchRow[]>;
  findRecentResearch(brandKey: string, kind: string, researchKey: string, since: string): Promise<ResearchRow | null>;
  applyOps(brandKey: string, ops: ResolvedOp[], author: ContextAuthor, actor: string | null): Promise<{ applied: number }>;
  claimBriefImport(brandKey: string): Promise<boolean>;
  releaseBriefImportClaim(brandKey: string): Promise<boolean>;
  getBriefImportState(brandKey: string): Promise<{ checkedAt: string | null; imported: boolean }>;
  markBriefImported(brandKey: string): Promise<void>;
  getBrandBrief(brand: BrandBriefLookup): Promise<Record<string, unknown> | null>;
};

function unavailable(message = "Context could not be loaded. Please retry.", cause?: unknown): AppError {
  return new AppError(503, "context_unavailable", message, { cause });
}

function mapSection(row: Record<string, unknown>): SectionRow {
  return {
    key: String(row.key),
    title: (row.title as string | null) ?? null,
    content: String(row.content),
    updatedAt: String(row.updated_at),
    updatedBy: row.updated_by as ContextAuthor,
    updatedByUser: (row.updated_by_user as string | null) ?? null,
  };
}

function mapCompetitor(row: Record<string, unknown>): CompetitorRow {
  return {
    id: String(row.id),
    domain: String(row.domain),
    name: (row.name as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    source: row.source as CompetitorRow["source"],
    sourceUrl: (row.source_url as string | null) ?? null,
    updatedAt: String(row.updated_at),
    updatedBy: row.updated_by as ContextAuthor,
    updatedByUser: (row.updated_by_user as string | null) ?? null,
  };
}

function mapKeyPage(row: Record<string, unknown>): KeyPageRow {
  return {
    id: String(row.id),
    url: String(row.url),
    role: row.role as KeyPageRole,
    topic: (row.topic as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    updatedAt: String(row.updated_at),
    updatedBy: row.updated_by as ContextAuthor,
    updatedByUser: (row.updated_by_user as string | null) ?? null,
  };
}

function mapResearch(row: Record<string, unknown>): ResearchRow {
  return {
    id: String(row.id),
    entryDate: String(row.entry_date),
    kind: String(row.kind),
    researchKey: (row.research_key as string | null) ?? null,
    summary: String(row.summary),
    spendUsd: row.spend_usd === null || row.spend_usd === undefined ? null : Number(row.spend_usd),
    jobId: (row.job_id as string | null) ?? null,
    createdBy: row.created_by as ContextAuthor,
    createdByUser: (row.created_by_user as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

function postgresError(error: { message?: string } | null | undefined): string {
  return error?.message ?? "Unknown database error";
}

function mapApplyError(error: { message?: string } | null | undefined): AppError {
  const message = postgresError(error);
  if (message.startsWith("project_memory_cap:competitors")) {
    return new AppError(400, "context_cap", "A workspace can track 100 competitors. Remove some first.");
  }
  if (message.startsWith("project_memory_cap:key_pages")) {
    return new AppError(400, "context_cap", "A workspace can hold 100 key pages. This is a shortlist, not a page inventory.");
  }
  if (message.startsWith("project_memory_cap:custom_sections")) {
    return new AppError(400, "context_cap", "A workspace can hold 20 custom sections. Delete one first.");
  }
  if (message.startsWith("project_memory_invalid:")) {
    return new AppError(400, "context_invalid", "These changes could not be applied.");
  }
  return unavailable("Context could not be saved. Please retry.", error);
}

export function createProjectContextRepository(admin: SupabaseClient): ProjectContextRepository {
  return {
    async listSections(brandKey) {
      const { data, error } = await admin
        .from("project_context_sections")
        .select("key,title,content,updated_by,updated_by_user,updated_at")
        .eq("brand_key", brandKey)
        .order("key", { ascending: true });
      if (error) throw unavailable(undefined, error);
      return (data ?? []).map((row) => mapSection(row as Record<string, unknown>));
    },

    async listCompetitors(brandKey) {
      const { data, error } = await admin
        .from("project_competitors")
        .select("id,domain,name,notes,source,source_url,updated_by,updated_by_user,updated_at")
        .eq("brand_key", brandKey)
        .order("domain", { ascending: true });
      if (error) throw unavailable(undefined, error);
      return (data ?? []).map((row) => mapCompetitor(row as Record<string, unknown>));
    },

    async listKeyPages(brandKey) {
      const { data, error } = await admin
        .from("project_key_pages")
        .select("id,url,role,topic,notes,updated_by,updated_by_user,updated_at")
        .eq("brand_key", brandKey)
        .order("url", { ascending: true });
      if (error) throw unavailable(undefined, error);
      return (data ?? []).map((row) => mapKeyPage(row as Record<string, unknown>));
    },

    async listResearchLog(brandKey, limit) {
      const { data, error } = await admin
        .from("project_research_log")
        .select("id,entry_date,kind,research_key,summary,spend_usd,job_id,created_by,created_by_user,created_at")
        .eq("brand_key", brandKey)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw unavailable(undefined, error);
      return (data ?? []).map((row) => mapResearch(row as Record<string, unknown>));
    },

    async findRecentResearch(brandKey, kind, researchKey, since) {
      const { data, error } = await admin
        .from("project_research_log")
        .select("id,entry_date,kind,research_key,summary,spend_usd,job_id,created_by,created_by_user,created_at")
        .eq("brand_key", brandKey)
        .eq("kind", kind)
        .eq("research_key", researchKey)
        .gte("entry_date", since)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw unavailable(undefined, error);
      return data ? mapResearch(data as Record<string, unknown>) : null;
    },

    async applyOps(brandKey, ops, author, actor) {
      const { data, error } = await admin.rpc("apply_project_context_ops", {
        p_brand: brandKey,
        p_ops: ops,
        p_author: author,
        p_actor: actor,
      });
      if (error) throw mapApplyError(error);
      const result = data as { applied?: unknown } | null;
      return { applied: typeof result?.applied === "number" ? result.applied : ops.length };
    },

    async claimBriefImport(brandKey) {
      const { data, error } = await admin.rpc("claim_project_brief_import", { p_brand: brandKey });
      if (error) throw unavailable("Context could not be loaded. Please retry.", error);
      return data === true;
    },

    async releaseBriefImportClaim(brandKey) {
      const { data, error } = await admin.rpc("release_project_brief_import_claim", { p_brand: brandKey });
      if (error) throw unavailable("Context could not be saved. Please retry.", error);
      return data === true;
    },

    async getBriefImportState(brandKey) {
      const { data, error } = await admin
        .from("project_memory_state")
        .select("brief_import_checked_at,brief_imported")
        .eq("brand_key", brandKey)
        .maybeSingle();
      if (error) throw unavailable("Context could not be loaded. Please retry.", error);
      return {
        checkedAt: (data?.brief_import_checked_at as string | null | undefined) ?? null,
        imported: data?.brief_imported === true,
      };
    },

    async markBriefImported(brandKey) {
      const { error } = await admin
        .from("project_memory_state")
        .update({ brief_imported: true })
        .eq("brand_key", brandKey);
      if (error) throw unavailable("Context could not be saved. Please retry.", error);
    },

    async getBrandBrief(brand) {
      // Exact matches only: no ilike, no case folding, no substring search. The
      // fallback order is the whole compatibility story for legacy rows (§11
      // risk 8), and a fuzzy match here would import another brand's brief.
      for (const candidate of brandBriefCandidates(brand)) {
        const { data, error } = await admin
          .from("brand_briefs")
          .select("brief")
          .eq("brand", candidate)
          .maybeSingle();
        if (error) throw unavailable("Context could not be loaded. Please retry.", error);
        if (data && data.brief && typeof data.brief === "object" && !Array.isArray(data.brief)) {
          return data.brief as Record<string, unknown>;
        }
      }
      return null;
    },
  };
}
