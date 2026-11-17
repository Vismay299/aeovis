// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchJson, isApiError, withBrand } from "@/shared/query/fetchJson";
import { describeError } from "@/shared/query/errors";
import type { SavedKeywordTag } from "@/shared/keywords";

const TAG_DELETE_FALLBACK =
  "Could not delete tag. Detach it from all keywords and try again.";

export type TagApplyResult =
  | { ok: true; taggedCount: number }
  | { ok: false; error: string };

export function useTagManage(brandKey: string) {
  const queryClient = useQueryClient();
  const [pendingTagIds, setPendingTagIds] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["savedKeywords", brandKey] });

  const markPending = (tagId: string, pending: boolean) =>
    setPendingTagIds((current) =>
      pending
        ? current.includes(tagId)
          ? current
          : [...current, tagId]
        : current.filter((id) => id !== tagId),
    );

  const updateTag = async (
    tagId: string,
    patch: { name?: string; color?: string | null },
  ): Promise<SavedKeywordTag | null> => {
    markPending(tagId, true);
    try {
      const result = await fetchJson<{ tag: SavedKeywordTag }>(
        withBrand(
          `/api/customer/keywords/tags/${encodeURIComponent(tagId)}`,
          brandKey,
        ),
        { method: "PATCH", body: patch },
      );
      toast.success("Tag updated");
      await invalidate();
      return result.tag;
    } catch (error) {
      toast.error(describeError(error));
      return null;
    } finally {
      markPending(tagId, false);
    }
  };

  const deleteTag = async (tagId: string): Promise<boolean> => {
    markPending(tagId, true);
    try {
      await fetchJson(
        withBrand(
          `/api/customer/keywords/tags/${encodeURIComponent(tagId)}`,
          brandKey,
        ),
        { method: "DELETE" },
      );
      toast.success("Tag deleted");
      await invalidate();
      return true;
    } catch {
      // The API message names the keyword count; the page's own sentence is
      // the one the spec asks the reader to act on.
      toast.error(TAG_DELETE_FALLBACK);
      return false;
    } finally {
      markPending(tagId, false);
    }
  };

  /** Add and/or remove tags on the selected saved keywords. */
  const applyTags = async (args: {
    savedKeywordIds: string[];
    addTags?: string[];
    removeTagIds?: string[];
  }): Promise<TagApplyResult> => {
    setApplying(true);
    try {
      const result = await fetchJson<{ taggedCount: number }>(
        withBrand("/api/customer/keywords/saved/tags", brandKey),
        {
          method: "POST",
          body: {
            savedKeywordIds: args.savedKeywordIds,
            ...(args.addTags?.length ? { addTags: args.addTags } : {}),
            ...(args.removeTagIds?.length
              ? { removeTagIds: args.removeTagIds }
              : {}),
          },
        },
      );
      const count = result.taggedCount;
      toast.success(
        `Updated tags for ${count} keyword${count === 1 ? "" : "s"}`,
      );
      await invalidate();
      return { ok: true, taggedCount: count };
    } catch (error) {
      return {
        ok: false,
        error: isApiError(error) ? error.message : describeError(error),
      };
    } finally {
      setApplying(false);
    }
  };

  return {
    pendingTagIds,
    applying,
    updateTag,
    deleteTag,
    applyTags,
  };
}

export type TagManageController = ReturnType<typeof useTagManage>;
