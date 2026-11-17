"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/project-context/shared.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ContextAuthor } from "@/shared/project-context";
import { relativeTime } from "@/shared/format";

export function getAuthorLabel(
  by: ContextAuthor,
  userId?: string | null,
  currentUserId?: string | null,
): string {
  if (by === "assistant") return "the assistant";
  if (by === "system") return "Perceev";
  if (by === "user") {
    if (currentUserId && userId && currentUserId === userId) {
      return "you";
    }
    if (currentUserId && userId && currentUserId !== userId) {
      return "a teammate";
    }
    // If current user is known and matches or defaults
    if (currentUserId && !userId) {
      return "a teammate";
    }
    return "you";
  }
  return "Perceev";
}

export function Provenance({
  by,
  at,
  userId,
  currentUserId,
}: {
  by: ContextAuthor;
  at?: string;
  userId?: string | null;
  currentUserId?: string | null;
}) {
  const author = getAuthorLabel(by, userId, currentUserId);
  const time = at ? relativeTime(at) : null;

  return (
    <span className="text-xs text-muted-foreground">
      {time ? `Updated by ${author} · ${time}` : `Added by ${author}`}
    </span>
  );
}
