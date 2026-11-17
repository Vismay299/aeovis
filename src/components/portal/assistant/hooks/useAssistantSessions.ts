// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/sam/useSamSessions.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import type { UIMessage } from "ai";
import { keys } from "@/shared/query/keys";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";

export type AssistantSessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type AssistantSkillSummary = {
  name: string;
  title: string;
  description: string;
  version: string;
};

export type AssistantConfig = {
  configured: boolean;
  reason?: "llm_not_configured" | "model_unpriced";
  turnMaxUsd: number;
  approvalTtlSeconds: number;
  skills: AssistantSkillSummary[];
  suggestions: string[];
};

export type AssistantSessionDetail = {
  session: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    hasKickoff: boolean;
  };
  messages: UIMessage[];
  activeTurn: { id: string; startedAt: string } | null;
};

export function assistantConfigQueryOptions(brandKey: string) {
  return {
    queryKey: keys.assistantConfig(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<AssistantConfig>(withBrand("/api/customer/assistant/config", brandKey), {
        signal,
      }),
    enabled: Boolean(brandKey),
  };
}

export function assistantSessionQueryOptions(brandKey: string, sessionId: string | undefined) {
  return {
    queryKey: keys.assistantSession(sessionId ?? ""),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<AssistantSessionDetail>(
        withBrand(
          `/api/customer/assistant/sessions/${encodeURIComponent(sessionId ?? "")}`,
          brandKey,
        ),
        { signal },
      ),
    enabled: Boolean(brandKey && sessionId),
  };
}

export function assistantSessionsQueryOptions(brandKey: string) {
  return {
    queryKey: keys.assistantSessions(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<{ sessions: AssistantSessionSummary[] }>(
        withBrand("/api/customer/assistant/sessions", brandKey),
        { signal },
      ),
    enabled: Boolean(brandKey),
  };
}

/**
 * The assistant chat list, a way to open a chat, and ways to start or archive
 * one. The assistant page and the session list share this so both navigate the
 * same way. `goToSession()` with no id opens the assistant route, which picks
 * the most recent chat or starts a new one.
 */
export function useAssistantSessions(
  brandKey: string,
  {
    replace = false,
    onNavigate,
  }: {
    replace?: boolean;
    onNavigate?: () => void;
  } = {},
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery(assistantSessionsQueryOptions(brandKey));
  const sessions = sessionsQuery.data?.sessions ?? [];

  const goToSession = useCallback(
    (sessionId?: string) => {
      router.replace(
        sessionId ? `/portal/assistant?s=${encodeURIComponent(sessionId)}` : "/portal/assistant",
        { scroll: false },
      );
      onNavigate?.();
    },
    [router, onNavigate],
  );

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: keys.assistantSessions(brandKey) }),
    [queryClient, brandKey],
  );

  const createSession = useMutation({
    // AssistantPage shows a create failure inline ("Failed to start a new
    // chat." + Retry), so opt out of the shared error toast.
    meta: { errorToast: false },
    mutationFn: () =>
      fetchJson<{ id: string; title: string }>("/api/customer/assistant/sessions", {
        method: "POST",
        body: { brand_key: brandKey },
      }),
    // Wait for the list to hold the new chat before opening it: the page
    // treats an id missing from the list as archived or unknown.
    onSuccess: async ({ id }) => {
      await invalidate();
      goToSession(id);
    },
    onSettled: async () => {
      await invalidate();
    },
  });

  const archiveSession = useMutation({
    mutationFn: (sessionId: string) =>
      fetchJson<{ id: string; title: string; archived: boolean }>(
        `/api/customer/assistant/sessions/${encodeURIComponent(sessionId)}`,
        { method: "PATCH", body: { brand_key: brandKey, archived: true } },
      ),
    onSuccess: async (_result, sessionId) => {
      // Drop the chat from the cached list before leaving it, so the page
      // cannot pick it again as the most recent chat.
      queryClient.setQueryData<{ sessions: AssistantSessionSummary[] }>(
        keys.assistantSessions(brandKey),
        (current) => ({
          sessions: (current?.sessions ?? []).filter((session) => session.id !== sessionId),
        }),
      );
      await invalidate();
    },
  });

  return {
    sessionsQuery,
    sessions,
    goToSession,
    createSession,
    archiveSession,
    invalidateSessions: invalidate,
  };
}
