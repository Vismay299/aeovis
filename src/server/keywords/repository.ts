// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/repositories/KeywordResearchRepository.ts
//   src/server/features/keywords/repositories/SavedKeywordTagsRepository.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/errors.ts";
import type {
  SavedKeywordRow,
  SavedKeywordTag,
  SavedKeywordTagSummary,
} from "../../shared/keywords.ts";

export type SavedKeywordsFilters = {
  search?: string | null;
  includeTerms?: string[];
  excludeTerms?: string[];
  minVolume?: number | null;
  maxVolume?: number | null;
  minCpc?: number | null;
  maxCpc?: number | null;
  minDifficulty?: number | null;
  maxDifficulty?: number | null;
  tagIds?: string[];
};

export type StaleMarketSummary = {
  locationCode: number;
  languageCode: string;
  stale: number;
  fresh: number;
  batches: number;
};

export type SavedKeywordsRepository = {
  save(i: {
    brandKey: string;
    keywords: string[];
    locationCode: number;
    languageCode: string;
    tags?: { name: string; normalized: string }[];
    tagMode?: "append" | "replace";
    actorUserId?: string | null;
  }): Promise<{ savedKeywordIds: string[]; created: number }>;

  list(i: {
    brandKey: string;
    filters?: SavedKeywordsFilters;
    sort?: string;
    order?: "asc" | "desc";
    page?: number;
    pageSize?: number;
  }): Promise<{
    rows: SavedKeywordRow[];
    totalCount: number;
    page: number;
    pageSize: number;
    tags: SavedKeywordTagSummary[];
  }>;

  listAllForExport(i: {
    brandKey: string;
    filters?: SavedKeywordsFilters;
    sort?: string;
    order?: "asc" | "desc";
  }): Promise<{
    rows: SavedKeywordRow[];
    totalCount: number;
    truncated: boolean;
  }>;

  updateTags(i: {
    brandKey: string;
    savedKeywordIds: string[];
    addTags?: { name: string; normalized: string }[];
    removeTagIds?: string[];
  }): Promise<{
    taggedCount: number;
    addedTags: SavedKeywordTag[];
    removedTagIds: string[];
    removedAssignments: number;
  }>;

  renameTag(i: {
    brandKey: string;
    tagId: string;
    name: string;
    normalized: string;
  }): Promise<SavedKeywordTag>;

  recolorTag(i: {
    brandKey: string;
    tagId: string;
    color: string | null;
  }): Promise<SavedKeywordTag>;

  deleteTag(i: {
    brandKey: string;
    tagId: string;
  }): Promise<{
    status: "deleted" | "in_use" | "not_found";
    assignmentCount?: number;
  }>;

  remove(i: {
    brandKey: string;
    savedKeywordIds: string[];
  }): Promise<{ deletedCount: number }>;

  tagIdsByNames(brandKey: string, names: string[]): Promise<string[]>;

  staleMarkets(
    brandKey: string,
    before: string,
    startedAt: string,
  ): Promise<{
    markets: StaleMarketSummary[];
    fresh: number;
  }>;

  staleBatch(
    brandKey: string,
    market: { locationCode: number; languageCode: string },
    before: string,
    startedAt: string,
    offset: number,
    limit: number,
  ): Promise<string[]>;
};

function mapDatabaseError(err: unknown): never {
  if (err instanceof AppError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code;

  if (message.includes("saved_keywords_cap:keywords")) {
    throw new AppError(
      409,
      "saved_keywords_limit",
      "A workspace can save up to 5,000 keywords. Delete some first.",
    );
  }
  if (message.includes("saved_keywords_cap:tags")) {
    throw new AppError(
      409,
      "tag_limit",
      "A workspace can have up to 200 tags. Delete unused tags first.",
    );
  }
  if (message.includes("saved_keywords_invalid:replace_requires_tags")) {
    throw new AppError(
      400,
      "invalid_request",
      "Replacement tags are required when tagMode is replace.",
    );
  }
  if (message.includes("saved_keywords_invalid:")) {
    throw new AppError(
      400,
      "invalid_request",
      "These keywords could not be saved.",
    );
  }
  if (code === "23505" || message.includes("saved_keyword_tags_unique_name")) {
    throw new AppError(
      409,
      "tag_name_taken",
      "Another tag already has this name.",
    );
  }
  throw new AppError(
    503,
    "keywords_unavailable",
    "Saved keywords are unavailable. Please retry.",
  );
}

export function createSavedKeywordsRepository(
  admin: SupabaseClient,
): SavedKeywordsRepository {
  return {
    async save(i) {
      try {
        const { data, error } = await admin.rpc("save_keywords", {
          p_brand: i.brandKey,
          p_keywords: i.keywords,
          p_location: i.locationCode,
          p_language: i.languageCode,
          p_tags: i.tags ?? [],
          p_tag_mode: i.tagMode ?? "append",
          p_actor: i.actorUserId ?? null,
        });
        if (error) throw error;
        return data as { savedKeywordIds: string[]; created: number };
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async list(i) {
      try {
        const page = i.page ?? 1;
        const pageSize = i.pageSize ?? 50;
        const offset = (page - 1) * pageSize;
        const { data, error } = await admin.rpc("list_saved_keywords", {
          p_brand: i.brandKey,
          p_filters: i.filters ?? {},
          p_sort: i.sort ?? "fetchedAt",
          p_order: i.order ?? "desc",
          p_limit: pageSize,
          p_offset: offset,
        });
        if (error) throw error;
        const typed = data as {
          rows: SavedKeywordRow[];
          totalCount: number;
          tags: SavedKeywordTagSummary[];
        };
        return {
          rows: typed.rows ?? [],
          totalCount: typed.totalCount ?? 0,
          page,
          pageSize,
          tags: typed.tags ?? [],
        };
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async listAllForExport(i) {
      try {
        const { data, error } = await admin.rpc("list_saved_keywords", {
          p_brand: i.brandKey,
          p_filters: i.filters ?? {},
          p_sort: i.sort ?? "fetchedAt",
          p_order: i.order ?? "desc",
          // Migration 102 caps list_saved_keywords at 5000 rows (1..5000).
          p_limit: 5000,
          p_offset: 0,
        });
        if (error) throw error;
        const typed = data as {
          rows: SavedKeywordRow[];
          totalCount: number;
        };
        // Truncation comes from the filtered total, not from a 5001st row.
        const truncated = (typed.totalCount ?? 0) > 5000;
        return {
          rows: typed.rows ?? [],
          totalCount: typed.totalCount ?? 0,
          truncated,
        };
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async updateTags(i) {
      try {
        const { data, error } = await admin.rpc("update_saved_keyword_tags", {
          p_brand: i.brandKey,
          p_ids: i.savedKeywordIds,
          p_add: i.addTags ?? [],
          p_remove: i.removeTagIds ?? [],
        });
        if (error) throw error;
        return data as {
          taggedCount: number;
          addedTags: SavedKeywordTag[];
          removedTagIds: string[];
          removedAssignments: number;
        };
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async renameTag(i) {
      try {
        const { data, error } = await admin
          .from("saved_keyword_tags")
          .update({
            name: i.name,
            normalized_name: i.normalized,
          })
          .eq("brand_key", i.brandKey)
          .eq("id", i.tagId)
          .select("id, name, normalized_name, color")
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          throw new AppError(404, "tag_not_found", "Tag not found.");
        }
        return {
          id: data.id,
          name: data.name,
          normalizedName: data.normalized_name,
          color: data.color,
        };
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async recolorTag(i) {
      try {
        const { data, error } = await admin
          .from("saved_keyword_tags")
          .update({
            color: i.color,
          })
          .eq("brand_key", i.brandKey)
          .eq("id", i.tagId)
          .select("id, name, normalized_name, color")
          .maybeSingle();

        if (error) throw error;
        if (!data) {
          throw new AppError(404, "tag_not_found", "Tag not found.");
        }
        return {
          id: data.id,
          name: data.name,
          normalizedName: data.normalized_name,
          color: data.color,
        };
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async deleteTag(i) {
      try {
        const { data, error } = await admin.rpc("delete_saved_keyword_tag", {
          p_brand: i.brandKey,
          p_tag: i.tagId,
        });
        if (error) throw error;
        return data as {
          status: "deleted" | "in_use" | "not_found";
          assignmentCount?: number;
        };
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async remove(i) {
      try {
        const { data, error } = await admin.rpc("remove_saved_keywords", {
          p_brand: i.brandKey,
          p_ids: i.savedKeywordIds,
        });
        if (error) throw error;
        return { deletedCount: Number(data) };
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async tagIdsByNames(brandKey, names) {
      try {
        if (!names || names.length === 0) return [];
        const normalized = names.map((n) => n.trim().toLowerCase());
        const { data, error } = await admin
          .from("saved_keyword_tags")
          .select("id")
          .eq("brand_key", brandKey)
          .in("normalized_name", normalized);

        if (error) throw error;
        return (data ?? []).map((row: { id: string }) => row.id);
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async staleMarkets(brandKey, before, startedAt) {
      try {
        // Find saved keywords created before startedAt
        // Stale: metric missing or fetched_at < before or fetched_at >= startedAt
        // Fresh: metric exists and fetched_at >= before and fetched_at < startedAt
        const { data, error } = await admin
          .from("saved_keywords")
          .select(
            `
            location_code,
            language_code,
            keyword
          `,
          )
          .eq("brand_key", brandKey)
          .lt("created_at", startedAt);

        if (error) throw error;
        const saved = (data ?? []) as {
          location_code: number;
          language_code: string;
          keyword: string;
        }[];

        if (saved.length === 0) {
          return { markets: [], fresh: 0 };
        }

        // Fetch metrics for these unique markets/keywords
        const marketsMap = new Map<
          string,
          {
            locationCode: number;
            languageCode: string;
            keywords: string[];
          }
        >();

        for (const row of saved) {
          const key = `${row.location_code}:${row.language_code}`;
          let entry = marketsMap.get(key);
          if (!entry) {
            entry = {
              locationCode: row.location_code,
              languageCode: row.language_code,
              keywords: [],
            };
            marketsMap.set(key, entry);
          }
          entry.keywords.push(row.keyword);
        }

        let totalFresh = 0;
        const resultMarkets: StaleMarketSummary[] = [];

        for (const market of marketsMap.values()) {
          const { data: metricsData, error: metricsErr } = await admin
            .from("keyword_metrics")
            .select("keyword, fetched_at")
            .eq("location_code", market.locationCode)
            .eq("language_code", market.languageCode)
            .in("keyword", market.keywords);

          if (metricsErr) throw metricsErr;
          const metricMap = new Map<string, string>();
          for (const m of (metricsData ?? []) as {
            keyword: string;
            fetched_at: string;
          }[]) {
            metricMap.set(m.keyword, m.fetched_at);
          }

          let staleCount = 0;
          let freshCount = 0;
          for (const kw of market.keywords) {
            const fetchedAt = metricMap.get(kw);
            if (!fetchedAt || fetchedAt < before || fetchedAt >= startedAt) {
              staleCount++;
            } else {
              freshCount++;
            }
          }

          totalFresh += freshCount;
          if (staleCount > 0) {
            resultMarkets.push({
              locationCode: market.locationCode,
              languageCode: market.languageCode,
              stale: staleCount,
              fresh: freshCount,
              batches: Math.ceil(staleCount / 700),
            });
          }
        }

        return { markets: resultMarkets, fresh: totalFresh };
      } catch (err) {
        mapDatabaseError(err);
      }
    },

    async staleBatch(brandKey, market, before, startedAt, offset, limit) {
      try {
        const { data, error } = await admin
          .from("saved_keywords")
          .select("keyword")
          .eq("brand_key", brandKey)
          .eq("location_code", market.locationCode)
          .eq("language_code", market.languageCode)
          .lt("created_at", startedAt)
          .order("keyword", { ascending: true });

        if (error) throw error;
        const kws = ((data ?? []) as { keyword: string }[]).map(
          (r) => r.keyword,
        );
        if (kws.length === 0) return [];

        const { data: metricsData, error: metricsErr } = await admin
          .from("keyword_metrics")
          .select("keyword, fetched_at")
          .eq("location_code", market.locationCode)
          .eq("language_code", market.languageCode)
          .in("keyword", kws);

        if (metricsErr) throw metricsErr;
        const metricMap = new Map<string, string>();
        for (const m of (metricsData ?? []) as {
          keyword: string;
          fetched_at: string;
        }[]) {
          metricMap.set(m.keyword, m.fetched_at);
        }

        const staleKeywords: string[] = [];
        for (const kw of kws) {
          const fetchedAt = metricMap.get(kw);
          if (!fetchedAt || fetchedAt < before || fetchedAt >= startedAt) {
            staleKeywords.push(kw);
          }
        }

        return staleKeywords.slice(offset, offset + limit);
      } catch (err) {
        mapDatabaseError(err);
      }
    },
  };
}
