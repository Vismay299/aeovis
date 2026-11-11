// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/repositories/KeywordResearchRepository.ts
//   src/server/features/keywords/repositories/SavedKeywordTagsRepository.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";
import { AppError } from "../http/errors.ts";
import type {
  SavedKeywordRow,
  SavedKeywordTag,
  SavedKeywordTagSummary,
  MonthlySearch,
} from "../../shared/keywords.ts";
import type {
  SavedKeywordsRepository,
  SavedKeywordsFilters,
  StaleMarketSummary,
} from "./repository.ts";

export type MemoryMetric = {
  keyword: string;
  locationCode: number;
  languageCode: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: number | null;
  keywordDifficulty: number | null;
  intent: string | null;
  monthlySearches: MonthlySearch[];
  fetchedAt: string;
};

export type MemorySavedKeyword = {
  id: string;
  brandKey: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  createdAt: string;
  createdBy?: string | null;
};

export type MemoryTag = {
  id: string;
  brandKey: string;
  name: string;
  normalizedName: string;
  color: string | null;
};

export type MemoryTagAssignment = {
  brandKey: string;
  savedKeywordId: string;
  tagId: string;
};

export function createMemorySavedKeywordsRepository(initial?: {
  keywords?: MemorySavedKeyword[];
  tags?: MemoryTag[];
  assignments?: MemoryTagAssignment[];
  metrics?: MemoryMetric[];
}): SavedKeywordsRepository & {
  setMetric(metric: MemoryMetric): void;
  getKeywords(): MemorySavedKeyword[];
  getTags(): MemoryTag[];
  getAssignments(): MemoryTagAssignment[];
} {
  const keywords: MemorySavedKeyword[] = [...(initial?.keywords ?? [])];
  const tags: MemoryTag[] = [...(initial?.tags ?? [])];
  const assignments: MemoryTagAssignment[] = [...(initial?.assignments ?? [])];
  const metrics: MemoryMetric[] = [...(initial?.metrics ?? [])];

  function getMetric(kw: string, loc: number, lang: string) {
    return metrics.find(
      (m) =>
        m.keyword === kw &&
        m.locationCode === loc &&
        m.languageCode === lang,
    );
  }

  function getKeywordTags(brandKey: string, savedKeywordId: string) {
    const tagIds = assignments
      .filter((a) => a.brandKey === brandKey && a.savedKeywordId === savedKeywordId)
      .map((a) => a.tagId);
    return tags
      .filter((t) => tagIds.includes(t.id))
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
  }

  return {
    setMetric(m) {
      const idx = metrics.findIndex(
        (x) =>
          x.keyword === m.keyword &&
          x.locationCode === m.locationCode &&
          x.languageCode === m.languageCode,
      );
      if (idx !== -1) metrics[idx] = m;
      else metrics.push(m);
    },
    getKeywords: () => keywords,
    getTags: () => tags,
    getAssignments: () => assignments,

    async save(i) {
      if (i.tagMode === "replace" && (!i.tags || i.tags.length === 0)) {
        throw new AppError(
          400,
          "invalid_request",
          "Replacement tags are required when tagMode is replace.",
        );
      }

      const existingCount = keywords.filter((k) => k.brandKey === i.brandKey).length;
      const newKeywords = i.keywords.filter(
        (kw) =>
          !keywords.some(
            (k) =>
              k.brandKey === i.brandKey &&
              k.keyword === kw &&
              k.locationCode === i.locationCode &&
              k.languageCode === i.languageCode,
          ),
      );

      if (existingCount + newKeywords.length > 5000) {
        throw new AppError(
          409,
          "saved_keywords_limit",
          "A workspace can save up to 5,000 keywords. Delete some first.",
        );
      }

      // Check tag cap
      if (i.tags && i.tags.length > 0) {
        const brandTags = tags.filter((t) => t.brandKey === i.brandKey);
        const newTagNames = i.tags.filter(
          (t) => !brandTags.some((bt) => bt.normalizedName === t.normalized),
        );
        if (brandTags.length + newTagNames.length > 200) {
          throw new AppError(
            409,
            "tag_limit",
            "A workspace can have up to 200 tags. Delete unused tags first.",
          );
        }
      }

      let created = 0;
      const savedIds: string[] = [];

      for (const kw of i.keywords) {
        let existing = keywords.find(
          (k) =>
            k.brandKey === i.brandKey &&
            k.keyword === kw &&
            k.locationCode === i.locationCode &&
            k.languageCode === i.languageCode,
        );
        if (!existing) {
          existing = {
            id: randomUUID(),
            brandKey: i.brandKey,
            keyword: kw,
            locationCode: i.locationCode,
            languageCode: i.languageCode,
            createdAt: new Date().toISOString(),
            createdBy: i.actorUserId,
          };
          keywords.push(existing);
          created++;
        }
        savedIds.push(existing.id);
      }

      // Handle tags
      if (i.tags && i.tags.length > 0) {
        const tagIds: string[] = [];
        for (const t of i.tags) {
          let existingTag = tags.find(
            (tag) => tag.brandKey === i.brandKey && tag.normalizedName === t.normalized,
          );
          if (!existingTag) {
            existingTag = {
              id: randomUUID(),
              brandKey: i.brandKey,
              name: t.name,
              normalizedName: t.normalized,
              color: null,
            };
            tags.push(existingTag);
          }
          tagIds.push(existingTag.id);
        }

        for (const kwId of savedIds) {
          if (i.tagMode === "replace") {
            // Remove old assignments
            for (let idx = assignments.length - 1; idx >= 0; idx--) {
              if (
                assignments[idx].brandKey === i.brandKey &&
                assignments[idx].savedKeywordId === kwId &&
                !tagIds.includes(assignments[idx].tagId)
              ) {
                assignments.splice(idx, 1);
              }
            }
          }

          // Add assignments
          for (const tid of tagIds) {
            if (
              !assignments.some(
                (a) =>
                  a.brandKey === i.brandKey &&
                  a.savedKeywordId === kwId &&
                  a.tagId === tid,
              )
            ) {
              assignments.push({
                brandKey: i.brandKey,
                savedKeywordId: kwId,
                tagId: tid,
              });
            }
          }
        }
      }

      return {
        savedKeywordIds: savedIds,
        created,
      };
    },

    async list(i) {
      let filtered = keywords.filter((k) => k.brandKey === i.brandKey);

      const f = i.filters ?? {};
      if (f.search && f.search.trim()) {
        const s = f.search.trim().toLowerCase();
        filtered = filtered.filter((k) => k.keyword.toLowerCase().includes(s));
      }
      if (f.includeTerms && f.includeTerms.length > 0) {
        filtered = filtered.filter((k) => {
          const kw = k.keyword.toLowerCase();
          return f.includeTerms!.every((t) => kw.includes(t.toLowerCase()));
        });
      }
      if (f.excludeTerms && f.excludeTerms.length > 0) {
        filtered = filtered.filter((k) => {
          const kw = k.keyword.toLowerCase();
          return !f.excludeTerms!.some((t) => kw.includes(t.toLowerCase()));
        });
      }
      if (f.tagIds && f.tagIds.length > 0) {
        filtered = filtered.filter((k) => {
          const kwTagIds = assignments
            .filter((a) => a.brandKey === i.brandKey && a.savedKeywordId === k.id)
            .map((a) => a.tagId);
          return f.tagIds!.some((tid) => kwTagIds.includes(tid));
        });
      }

      // Metrics filters
      if (
        f.minVolume != null ||
        f.maxVolume != null ||
        f.minCpc != null ||
        f.maxCpc != null ||
        f.minDifficulty != null ||
        f.maxDifficulty != null
      ) {
        filtered = filtered.filter((k) => {
          const m = getMetric(k.keyword, k.locationCode, k.languageCode);
          if (f.minVolume != null && (m?.searchVolume == null || m.searchVolume < f.minVolume))
            return false;
          if (f.maxVolume != null && (m?.searchVolume == null || m.searchVolume > f.maxVolume))
            return false;
          if (f.minCpc != null && (m?.cpc == null || m.cpc < f.minCpc)) return false;
          if (f.maxCpc != null && (m?.cpc == null || m.cpc > f.maxCpc)) return false;
          if (
            f.minDifficulty != null &&
            (m?.keywordDifficulty == null || m.keywordDifficulty < f.minDifficulty)
          )
            return false;
          if (
            f.maxDifficulty != null &&
            (m?.keywordDifficulty == null || m.keywordDifficulty > f.maxDifficulty)
          )
            return false;
          return true;
        });
      }

      const totalCount = filtered.length;

      // Sort with NULLS LAST
      const sort = i.sort ?? "fetchedAt";
      const order = i.order ?? "desc";
      const factor = order === "asc" ? 1 : -1;

      filtered.sort((a, b) => {
        const ma = getMetric(a.keyword, a.locationCode, a.languageCode);
        const mb = getMetric(b.keyword, b.locationCode, b.languageCode);

        let va: any;
        let vb: any;

        switch (sort) {
          case "keyword":
            return a.keyword.localeCompare(b.keyword) * factor;
          case "createdAt":
            va = a.createdAt;
            vb = b.createdAt;
            break;
          case "searchVolume":
            va = ma?.searchVolume ?? null;
            vb = mb?.searchVolume ?? null;
            break;
          case "cpc":
            va = ma?.cpc ?? null;
            vb = mb?.cpc ?? null;
            break;
          case "competition":
            va = ma?.competition ?? null;
            vb = mb?.competition ?? null;
            break;
          case "keywordDifficulty":
            va = ma?.keywordDifficulty ?? null;
            vb = mb?.keywordDifficulty ?? null;
            break;
          case "fetchedAt":
          default:
            va = ma?.fetchedAt ?? null;
            vb = mb?.fetchedAt ?? null;
            break;
        }

        if (va == null && vb == null) return 0;
        if (va == null) return 1; // NULLS LAST
        if (vb == null) return -1; // NULLS LAST

        if (typeof va === "string" && typeof vb === "string") {
          return va.localeCompare(vb) * factor;
        }
        return (va < vb ? -1 : va > vb ? 1 : 0) * factor;
      });

      const page = i.page ?? 1;
      const pageSize = i.pageSize ?? 50;
      const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

      const rows: SavedKeywordRow[] = paged.map((k) => {
        const m = getMetric(k.keyword, k.locationCode, k.languageCode);
        return {
          id: k.id,
          keyword: k.keyword,
          locationCode: k.locationCode,
          languageCode: k.languageCode,
          createdAt: k.createdAt,
          searchVolume: m?.searchVolume ?? null,
          cpc: m?.cpc ?? null,
          competition: m?.competition ?? null,
          keywordDifficulty: m?.keywordDifficulty ?? null,
          intent: m?.intent ?? null,
          monthlySearches: m?.monthlySearches ?? [],
          fetchedAt: m?.fetchedAt ?? null,
          tags: getKeywordTags(k.brandKey, k.id),
        };
      });

      const brandTags = tags.filter((t) => t.brandKey === i.brandKey);
      const tagSummaries: SavedKeywordTagSummary[] = brandTags
        .map((t) => ({
          ...t,
          keywordCount: assignments.filter(
            (a) => a.brandKey === i.brandKey && a.tagId === t.id,
          ).length,
        }))
        .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));

      return {
        rows,
        totalCount,
        page,
        pageSize,
        tags: tagSummaries,
      };
    },

    async listAllForExport(i) {
      const fullList = await this.list({
        brandKey: i.brandKey,
        filters: i.filters,
        sort: i.sort,
        order: i.order,
        page: 1,
        pageSize: 5001,
      });

      const truncated = fullList.totalCount > 5000 || fullList.rows.length > 5000;
      return {
        rows: fullList.rows.slice(0, 5000),
        totalCount: fullList.totalCount,
        truncated,
      };
    },

    async updateTags(i) {
      const validKwIds = keywords
        .filter((k) => k.brandKey === i.brandKey && i.savedKeywordIds.includes(k.id))
        .map((k) => k.id);

      if (validKwIds.length === 0) {
        return {
          taggedCount: 0,
          addedTags: [],
          removedTagIds: [],
          removedAssignments: 0,
        };
      }

      // Check tag cap
      if (i.addTags && i.addTags.length > 0) {
        const brandTags = tags.filter((t) => t.brandKey === i.brandKey);
        const newTagNames = i.addTags.filter(
          (t) => !brandTags.some((bt) => bt.normalizedName === t.normalized),
        );
        if (brandTags.length + newTagNames.length > 200) {
          throw new AppError(
            409,
            "tag_limit",
            "A workspace can have up to 200 tags. Delete unused tags first.",
          );
        }
      }

      const addedTags: SavedKeywordTag[] = [];
      if (i.addTags && i.addTags.length > 0) {
        for (const t of i.addTags) {
          let existingTag = tags.find(
            (tag) => tag.brandKey === i.brandKey && tag.normalizedName === t.normalized,
          );
          if (!existingTag) {
            existingTag = {
              id: randomUUID(),
              brandKey: i.brandKey,
              name: t.name,
              normalizedName: t.normalized,
              color: null,
            };
            tags.push(existingTag);
          }
          if (!addedTags.some((at) => at.id === existingTag!.id)) {
            addedTags.push({ ...existingTag });
          }

          for (const kwId of validKwIds) {
            if (
              !assignments.some(
                (a) =>
                  a.brandKey === i.brandKey &&
                  a.savedKeywordId === kwId &&
                  a.tagId === existingTag!.id,
              )
            ) {
              assignments.push({
                brandKey: i.brandKey,
                savedKeywordId: kwId,
                tagId: existingTag!.id,
              });
            }
          }
        }
      }

      let removedAssignments = 0;
      const removedTagIds: string[] = [];
      if (i.removeTagIds && i.removeTagIds.length > 0) {
        for (const tid of i.removeTagIds) {
          if (tags.some((t) => t.brandKey === i.brandKey && t.id === tid)) {
            removedTagIds.push(tid);
          }
          for (let idx = assignments.length - 1; idx >= 0; idx--) {
            if (
              assignments[idx].brandKey === i.brandKey &&
              validKwIds.includes(assignments[idx].savedKeywordId) &&
              assignments[idx].tagId === tid
            ) {
              assignments.splice(idx, 1);
              removedAssignments++;
            }
          }
        }
      }

      return {
        taggedCount: validKwIds.length,
        addedTags: addedTags.sort((a, b) =>
          a.normalizedName.localeCompare(b.normalizedName),
        ),
        removedTagIds,
        removedAssignments,
      };
    },

    async renameTag(i) {
      const tag = tags.find((t) => t.brandKey === i.brandKey && t.id === i.tagId);
      if (!tag) {
        throw new AppError(404, "tag_not_found", "Tag not found.");
      }
      const clash = tags.find(
        (t) =>
          t.brandKey === i.brandKey &&
          t.id !== i.tagId &&
          t.normalizedName === i.normalized,
      );
      if (clash) {
        throw new AppError(
          409,
          "tag_name_taken",
          "Another tag already has this name.",
        );
      }
      tag.name = i.name;
      tag.normalizedName = i.normalized;
      return { ...tag };
    },

    async recolorTag(i) {
      const tag = tags.find((t) => t.brandKey === i.brandKey && t.id === i.tagId);
      if (!tag) {
        throw new AppError(404, "tag_not_found", "Tag not found.");
      }
      tag.color = i.color;
      return { ...tag };
    },

    async deleteTag(i) {
      const tag = tags.find((t) => t.brandKey === i.brandKey && t.id === i.tagId);
      if (!tag) {
        return { status: "not_found" };
      }
      const inUseCount = assignments.filter(
        (a) => a.brandKey === i.brandKey && a.tagId === i.tagId,
      ).length;
      if (inUseCount > 0) {
        return { status: "in_use", assignmentCount: inUseCount };
      }
      const idx = tags.indexOf(tag);
      tags.splice(idx, 1);
      return { status: "deleted" };
    },

    async remove(i) {
      let count = 0;
      for (const id of i.savedKeywordIds) {
        const idx = keywords.findIndex(
          (k) => k.brandKey === i.brandKey && k.id === id,
        );
        if (idx !== -1) {
          keywords.splice(idx, 1);
          count++;
          // remove assignments
          for (let aidx = assignments.length - 1; aidx >= 0; aidx--) {
            if (
              assignments[aidx].brandKey === i.brandKey &&
              assignments[aidx].savedKeywordId === id
            ) {
              assignments.splice(aidx, 1);
            }
          }
        }
      }
      return { deletedCount: count };
    },

    async tagIdsByNames(brandKey, names) {
      if (!names || names.length === 0) return [];
      const norm = names.map((n) => n.trim().toLowerCase());
      return tags
        .filter((t) => t.brandKey === brandKey && norm.includes(t.normalizedName))
        .map((t) => t.id);
    },

    async staleMarkets(brandKey, before, startedAt) {
      const brandKeywords = keywords.filter(
        (k) => k.brandKey === brandKey && k.createdAt < startedAt,
      );

      const marketsMap = new Map<
        string,
        {
          locationCode: number;
          languageCode: string;
          stale: number;
          fresh: number;
        }
      >();

      let totalFresh = 0;

      for (const k of brandKeywords) {
        const key = `${k.locationCode}:${k.languageCode}`;
        let m = marketsMap.get(key);
        if (!m) {
          m = {
            locationCode: k.locationCode,
            languageCode: k.languageCode,
            stale: 0,
            fresh: 0,
          };
          marketsMap.set(key, m);
        }

        const metric = getMetric(k.keyword, k.locationCode, k.languageCode);
        if (!metric || metric.fetchedAt < before || metric.fetchedAt >= startedAt) {
          m.stale++;
        } else {
          m.fresh++;
          totalFresh++;
        }
      }

      const resultMarkets: StaleMarketSummary[] = [];
      for (const m of marketsMap.values()) {
        if (m.stale > 0) {
          resultMarkets.push({
            locationCode: m.locationCode,
            languageCode: m.languageCode,
            stale: m.stale,
            fresh: m.fresh,
            batches: Math.ceil(m.stale / 700),
          });
        }
      }

      return {
        markets: resultMarkets,
        fresh: totalFresh,
      };
    },

    async staleBatch(brandKey, market, before, startedAt, offset, limit) {
      const brandKeywords = keywords
        .filter(
          (k) =>
            k.brandKey === brandKey &&
            k.locationCode === market.locationCode &&
            k.languageCode === market.languageCode &&
            k.createdAt < startedAt,
        )
        .sort((a, b) => a.keyword.localeCompare(b.keyword));

      const stale: string[] = [];
      for (const k of brandKeywords) {
        const metric = getMetric(k.keyword, k.locationCode, k.languageCode);
        if (!metric || metric.fetchedAt < before || metric.fetchedAt >= startedAt) {
          stale.push(k.keyword);
        }
      }

      return stale.slice(offset, offset + limit);
    },
  };
}
