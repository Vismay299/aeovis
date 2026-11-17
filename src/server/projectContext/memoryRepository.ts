import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/http/appError.ts";
import {
  MAX_COMPETITORS,
  MAX_CUSTOM_SECTIONS,
  MAX_KEY_PAGES,
  RESEARCH_LOG_RETENTION_DAYS,
  type ContextAuthor,
} from "../../shared/project-context.ts";
import type { ResolvedOp } from "./contextUpdateOps.ts";
import { brandBriefCandidates } from "./repository.ts";
import type {
  CompetitorRow,
  KeyPageRow,
  ProjectContextRepository,
  ResearchRow,
  SectionRow,
} from "./repository.ts";

type StoredSection = SectionRow & { brandKey: string };
type StoredCompetitor = CompetitorRow & { brandKey: string };
type StoredKeyPage = KeyPageRow & { brandKey: string };
type StoredResearch = ResearchRow & { brandKey: string };

export type MemoryRepositorySeed = {
  now?: () => Date;
  brandBriefs?: Record<string, Record<string, unknown>>;
};

export type MemoryProjectContextRepository = ProjectContextRepository & {
  sections: Map<string, StoredSection>;
  competitors: Map<string, StoredCompetitor>;
  keyPages: Map<string, StoredKeyPage>;
  researchLog: StoredResearch[];
  briefChecked: Map<string, string>;
  briefImported: Set<string>;
};

function capError(message: string): AppError {
  return new AppError(400, "context_cap", message);
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function ageInDays(date: Date, days: number): string {
  return utcDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - days * 86_400_000));
}

function sectionKey(brandKey: string, key: string): string {
  return `${brandKey}\0${key}`;
}

function competitorKey(brandKey: string, domain: string): string {
  return `${brandKey}\0${domain}`;
}

function keyPageKey(brandKey: string, url: string): string {
  return `${brandKey}\0${url}`;
}

export function createMemoryProjectContextRepository(seed: MemoryRepositorySeed = {}): MemoryProjectContextRepository {
  const now = seed.now ?? (() => new Date());
  const brandBriefs = new Map(Object.entries(seed.brandBriefs ?? {}));
  const sections = new Map<string, StoredSection>();
  const competitors = new Map<string, StoredCompetitor>();
  const keyPages = new Map<string, StoredKeyPage>();
  const researchLog: StoredResearch[] = [];
  const briefChecked = new Map<string, string>();
  const briefImported = new Set<string>();
  let clockSequence = 0;

  const stamp = (): string => new Date(now().getTime() + clockSequence++).toISOString();

  const repo: MemoryProjectContextRepository = {
    sections,
    competitors,
    keyPages,
    researchLog,
    briefChecked,
    briefImported,

    async listSections(brandKey) {
      return [...sections.values()]
        .filter((row) => row.brandKey === brandKey)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ brandKey: _brandKey, ...row }) => ({ ...row }));
    },

    async listCompetitors(brandKey) {
      return [...competitors.values()]
        .filter((row) => row.brandKey === brandKey)
        .sort((a, b) => a.domain.localeCompare(b.domain))
        .map(({ brandKey: _brandKey, ...row }) => ({ ...row }));
    },

    async listKeyPages(brandKey) {
      return [...keyPages.values()]
        .filter((row) => row.brandKey === brandKey)
        .sort((a, b) => a.url.localeCompare(b.url))
        .map(({ brandKey: _brandKey, ...row }) => ({ ...row }));
    },

    async listResearchLog(brandKey, limit) {
      return researchLog
        .filter((row) => row.brandKey === brandKey)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(({ brandKey: _brandKey, ...row }) => ({ ...row }));
    },

    async findRecentResearch(brandKey, kind, researchKey, since) {
      const match = researchLog
        .filter((row) => row.brandKey === brandKey && row.kind === kind && row.researchKey === researchKey && row.entryDate >= since)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!match) return null;
      const { brandKey: _brandKey, ...row } = match;
      return { ...row };
    },

    async applyOps(brandKey, ops, author: ContextAuthor, actor) {
      const nextSections = new Map(sections);
      const nextCompetitors = new Map(competitors);
      const nextKeyPages = new Map(keyPages);
      const nextResearchLog = [...researchLog];

      for (const op of ops) {
        if (op.kind === "upsert_section" || op.kind === "insert_section_if_missing") {
          const id = sectionKey(brandKey, op.key);
          const existing = nextSections.get(id);
          if (op.kind === "insert_section_if_missing" && existing) continue;
          const at = stamp();
          nextSections.set(id, {
            brandKey,
            key: op.key,
            title: op.title ?? existing?.title ?? null,
            content: op.content,
            updatedAt: at,
            updatedBy: author,
            updatedByUser: actor,
          });
          continue;
        }

        if (op.kind === "delete_section") {
          nextSections.delete(sectionKey(brandKey, op.key));
          continue;
        }

        if (op.kind === "upsert_competitors" || op.kind === "insert_competitors_if_none") {
          if (op.kind === "insert_competitors_if_none" && [...nextCompetitors.values()].some((row) => row.brandKey === brandKey)) continue;
          for (const row of op.rows) {
            const id = competitorKey(brandKey, row.domain);
            const existing = nextCompetitors.get(id);
            const at = stamp();
            nextCompetitors.set(id, {
              brandKey,
              id: existing?.id ?? randomUUID(),
              domain: row.domain,
              name: row.name ?? existing?.name ?? null,
              notes: row.notes ?? existing?.notes ?? null,
              source: existing?.source ?? row.source,
              sourceUrl: row.source_url ?? existing?.sourceUrl ?? null,
              updatedAt: at,
              updatedBy: author,
              updatedByUser: actor,
            });
          }
          continue;
        }

        if (op.kind === "delete_competitors") {
          for (const domain of op.domains) nextCompetitors.delete(competitorKey(brandKey, domain));
          continue;
        }

        if (op.kind === "upsert_key_pages") {
          for (const row of op.rows) {
            const id = keyPageKey(brandKey, row.url);
            const existing = nextKeyPages.get(id);
            const at = stamp();
            nextKeyPages.set(id, {
              brandKey,
              id: existing?.id ?? randomUUID(),
              url: row.url,
              role: row.role ?? existing?.role ?? "other",
              topic: row.topic ?? existing?.topic ?? null,
              notes: row.notes ?? existing?.notes ?? null,
              updatedAt: at,
              updatedBy: author,
              updatedByUser: actor,
            });
          }
          continue;
        }

        if (op.kind === "delete_key_pages") {
          for (const url of op.urls) nextKeyPages.delete(keyPageKey(brandKey, url));
          continue;
        }

        if (op.kind === "append_research_log") {
          const at = new Date(stamp());
          nextResearchLog.push({
            brandKey,
            id: randomUUID(),
            entryDate: utcDay(now()),
            kind: op.research_kind,
            researchKey: op.research_key,
            summary: op.summary,
            spendUsd: op.spend_usd,
            jobId: op.job_id,
            createdBy: author,
            createdByUser: actor,
            createdAt: at.toISOString(),
          });
          const cutoff = ageInDays(now(), RESEARCH_LOG_RETENTION_DAYS);
          for (let index = nextResearchLog.length - 1; index >= 0; index -= 1) {
            const row = nextResearchLog[index];
            if (row.brandKey === brandKey && row.entryDate < cutoff) nextResearchLog.splice(index, 1);
          }
          continue;
        }

        if (op.kind === "delete_research_log") {
          const ids = new Set(op.ids);
          for (let index = nextResearchLog.length - 1; index >= 0; index -= 1) {
            const row = nextResearchLog[index];
            if (row.brandKey === brandKey && ids.has(row.id)) nextResearchLog.splice(index, 1);
          }
        }
      }

      const customCount = [...nextSections.values()].filter((row) => row.brandKey === brandKey && row.key.startsWith("custom:")).length;
      if (customCount > MAX_CUSTOM_SECTIONS) throw capError("A workspace can hold 20 custom sections. Delete one first.");
      const competitorCount = [...nextCompetitors.values()].filter((row) => row.brandKey === brandKey).length;
      if (competitorCount > MAX_COMPETITORS) throw capError("A workspace can track 100 competitors. Remove some first.");
      const keyPageCount = [...nextKeyPages.values()].filter((row) => row.brandKey === brandKey).length;
      if (keyPageCount > MAX_KEY_PAGES) {
        throw capError("A workspace can hold 100 key pages. This is a shortlist, not a page inventory.");
      }

      sections.clear();
      for (const [key, value] of nextSections) sections.set(key, value);
      competitors.clear();
      for (const [key, value] of nextCompetitors) competitors.set(key, value);
      keyPages.clear();
      for (const [key, value] of nextKeyPages) keyPages.set(key, value);
      researchLog.splice(0, researchLog.length, ...nextResearchLog);
      return { applied: ops.length };
    },

    async claimBriefImport(brandKey) {
      if (briefChecked.has(brandKey) || briefImported.has(brandKey)) return false;
      briefChecked.set(brandKey, stamp());
      return true;
    },

    async releaseBriefImportClaim(brandKey) {
      if (briefImported.has(brandKey) || !briefChecked.has(brandKey)) return false;
      briefChecked.delete(brandKey);
      return true;
    },

    async getBriefImportState(brandKey) {
      return {
        checkedAt: briefChecked.get(brandKey) ?? null,
        imported: briefImported.has(brandKey),
      };
    },

    async markBriefImported(brandKey) {
      briefImported.add(brandKey);
    },

    async getBrandBrief(brand) {
      // Same exact-match fallback order as the SQL-backed repository.
      for (const candidate of brandBriefCandidates(brand)) {
        const brief = brandBriefs.get(candidate);
        if (brief) return { ...brief };
      }
      return null;
    },
  };

  return repo;
}
