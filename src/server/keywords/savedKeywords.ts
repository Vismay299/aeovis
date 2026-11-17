// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/saved-keywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../shared/http/errors.ts";
import { normalizeKeyword } from "./helpers.ts";
import {
  normalizeSavedKeywordTag,
  normalizeSavedKeywordTags,
} from "../../shared/saved-keyword-tags.ts";
import type {
  SavedKeywordRow,
  SavedKeywordTag,
  SavedKeywordTagSummary,
} from "../../shared/keywords.ts";
import type {
  SavedKeywordsRepository,
  SavedKeywordsFilters,
} from "./repository.ts";

export type SaveKeywordsServiceInput = {
  brandKey: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
  tags?: string[];
  tagMode?: "append" | "replace";
  actorUserId?: string | null;
  metrics?: unknown;
};

export type GetSavedKeywordsServiceInput = {
  brandKey: string;
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
  tagNames?: string[];
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: "asc" | "desc";
};

export type ExportSavedKeywordsServiceInput = {
  brandKey: string;
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
  tagNames?: string[];
  sort?: string;
  order?: "asc" | "desc";
};

export type UpdateSavedKeywordTagsServiceInput = {
  brandKey: string;
  savedKeywordIds: string[];
  addTags?: string[];
  removeTagIds?: string[];
};

export type UpdateSavedKeywordTagServiceInput = {
  brandKey: string;
  tagId: string;
  name?: string;
  color?: string | null;
};

export type DeleteSavedKeywordTagServiceInput = {
  brandKey: string;
  tagId: string;
};

export type RemoveSavedKeywordsServiceInput = {
  brandKey: string;
  savedKeywordIds: string[];
};

export async function saveKeywords(
  repo: SavedKeywordsRepository,
  input: SaveKeywordsServiceInput,
): Promise<{ savedKeywordIds: string[]; created: number }> {
  // F13-AC-07: The save route accepts no metrics from the client
  if (input.metrics !== undefined) {
    throw new AppError(400, "invalid_request", "Client metrics are not accepted.");
  }

  const normalizedKeywords = [
    ...new Set(
      input.keywords.map(normalizeKeyword).filter((kw) => kw.length > 0),
    ),
  ];

  const tags = normalizeSavedKeywordTags(input.tags).map((t) => ({
    name: t.name,
    normalized: t.normalizedName,
  }));

  if (input.tagMode === "replace" && tags.length === 0) {
    throw new AppError(
      400,
      "invalid_request",
      "Replacement tags are required when tagMode is replace.",
    );
  }

  return await repo.save({
    brandKey: input.brandKey,
    keywords: normalizedKeywords,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    tags,
    tagMode: input.tagMode ?? "append",
    actorUserId: input.actorUserId,
  });
}

export async function getSavedKeywords(
  repo: SavedKeywordsRepository,
  input: GetSavedKeywordsServiceInput,
): Promise<{
  rows: SavedKeywordRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  tags: SavedKeywordTagSummary[];
}> {
  let effectiveTagIds = input.tagIds ? [...input.tagIds] : undefined;

  if (input.tagNames && input.tagNames.length > 0) {
    const resolvedIds = await repo.tagIdsByNames(input.brandKey, input.tagNames);
    if (resolvedIds.length === 0) {
      // F13-AC-14: an unknown tag name returns zero rows without querying keywords
      return {
        rows: [],
        totalCount: 0,
        page: input.page ?? 1,
        pageSize: input.pageSize ?? 50,
        tags: [],
      };
    }
    effectiveTagIds = [...(effectiveTagIds ?? []), ...resolvedIds];
  }

  const filters: SavedKeywordsFilters = {
    search: input.search,
    includeTerms: input.includeTerms,
    excludeTerms: input.excludeTerms,
    minVolume: input.minVolume,
    maxVolume: input.maxVolume,
    minCpc: input.minCpc,
    maxCpc: input.maxCpc,
    minDifficulty: input.minDifficulty,
    maxDifficulty: input.maxDifficulty,
    tagIds: effectiveTagIds,
  };

  return await repo.list({
    brandKey: input.brandKey,
    filters,
    sort: input.sort,
    order: input.order,
    page: input.page,
    pageSize: input.pageSize,
  });
}

export async function exportSavedKeywords(
  repo: SavedKeywordsRepository,
  input: ExportSavedKeywordsServiceInput,
): Promise<{
  rows: SavedKeywordRow[];
  totalCount: number;
  truncated: boolean;
}> {
  let effectiveTagIds = input.tagIds ? [...input.tagIds] : undefined;

  if (input.tagNames && input.tagNames.length > 0) {
    const resolvedIds = await repo.tagIdsByNames(input.brandKey, input.tagNames);
    if (resolvedIds.length === 0) {
      return {
        rows: [],
        totalCount: 0,
        truncated: false,
      };
    }
    effectiveTagIds = [...(effectiveTagIds ?? []), ...resolvedIds];
  }

  const filters: SavedKeywordsFilters = {
    search: input.search,
    includeTerms: input.includeTerms,
    excludeTerms: input.excludeTerms,
    minVolume: input.minVolume,
    maxVolume: input.maxVolume,
    minCpc: input.minCpc,
    maxCpc: input.maxCpc,
    minDifficulty: input.minDifficulty,
    maxDifficulty: input.maxDifficulty,
    tagIds: effectiveTagIds,
  };

  return await repo.listAllForExport({
    brandKey: input.brandKey,
    filters,
    sort: input.sort,
    order: input.order,
  });
}

export async function updateSavedKeywordTags(
  repo: SavedKeywordsRepository,
  input: UpdateSavedKeywordTagsServiceInput,
): Promise<{
  taggedCount: number;
  addedTags: SavedKeywordTag[];
  removedTagIds: string[];
  removedAssignments: number;
}> {
  const addTags = input.addTags
    ? normalizeSavedKeywordTags(input.addTags).map((t) => ({
        name: t.name,
        normalized: t.normalizedName,
      }))
    : undefined;

  return await repo.updateTags({
    brandKey: input.brandKey,
    savedKeywordIds: input.savedKeywordIds,
    addTags,
    removeTagIds: input.removeTagIds,
  });
}

export async function updateSavedKeywordTag(
  repo: SavedKeywordsRepository,
  input: UpdateSavedKeywordTagServiceInput,
): Promise<{
  tag: SavedKeywordTag;
}> {
  if (input.name === undefined && input.color === undefined) {
    throw new AppError(
      400,
      "invalid_request",
      "At least name or color must be provided.",
    );
  }

  let currentTag: SavedKeywordTag | undefined;

  if (input.name !== undefined) {
    const norm = normalizeSavedKeywordTag(input.name);
    if (!norm) {
      throw new AppError(400, "invalid_request", "Tag name cannot be empty.");
    }
    currentTag = await repo.renameTag({
      brandKey: input.brandKey,
      tagId: input.tagId,
      name: norm.name,
      normalized: norm.normalizedName,
    });
  }

  if (input.color !== undefined) {
    currentTag = await repo.recolorTag({
      brandKey: input.brandKey,
      tagId: input.tagId,
      color: input.color,
    });
  }

  return { tag: currentTag! };
}

export async function deleteSavedKeywordTag(
  repo: SavedKeywordsRepository,
  input: DeleteSavedKeywordTagServiceInput,
): Promise<{ deleted: true }> {
  const result = await repo.deleteTag({
    brandKey: input.brandKey,
    tagId: input.tagId,
  });

  if (result.status === "in_use") {
    const count = result.assignmentCount ?? 0;
    throw new AppError(
      409,
      "tag_in_use",
      `Tag is attached to ${count} keyword${count === 1 ? "" : "s"}. Remove the tag from those keywords first.`,
    );
  }

  if (result.status === "not_found") {
    throw new AppError(404, "tag_not_found", "Tag not found.");
  }

  return { deleted: true };
}

export async function removeSavedKeywords(
  repo: SavedKeywordsRepository,
  input: RemoveSavedKeywordsServiceInput,
): Promise<{ deletedCount: number }> {
  return await repo.remove({
    brandKey: input.brandKey,
    savedKeywordIds: input.savedKeywordIds,
  });
}
