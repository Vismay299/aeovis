// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/sam/SamSidebarPanel.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Archive, Plus } from "lucide-react";
import { usePortal } from "@/components/portal/PortalShell";
import { QueryError } from "@/components/app/QueryState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAssistantSessions } from "./hooks/useAssistantSessions.ts";

// Compact age label for the session list (PostHog-style "3h" / "12d").
// Timestamps come back as UTC from both backends: D1 as "YYYY-MM-DD HH:MM:SS"
// (no zone marker), Postgres as ISO-8601 with a trailing Z.
function ageLabel(timestamp: string): string {
  const iso = timestamp.includes("T") ? timestamp : `${timestamp}Z`;
  const then = new Date(iso.replace(" ", "T")).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The chat list for the assistant page: the workspace's chats plus a new-chat
 * button. Selecting (or creating) a session navigates to it; the conversation
 * itself renders in the content panel. Archive on hover removes the row.
 */
export function SessionList({
  activeId,
  onSelect,
  onCreate,
}: {
  activeId: string | undefined;
  onSelect: (sessionId?: string) => void;
  onCreate: () => void;
}) {
  const { brandKey } = usePortal();
  const { sessionsQuery, sessions, createSession, archiveSession } = useAssistantSessions(brandKey);

  const loading = sessionsQuery.isPending && sessions.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1">
        {/* Ghost row styled like a list item so the header doesn't stack three
            heavy full-width controls. */}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 font-normal text-muted-foreground"
          pending={createSession.isPending}
          onClick={onCreate}
        >
          {createSession.isPending ? null : <Plus />}
          New chat
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {loading ? (
          <div className="space-y-2 px-1 py-1" aria-busy="true" aria-label="Loading chats">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : sessionsQuery.isError && sessions.length === 0 ? (
          <div className="px-2 py-2">
            <QueryError
              error={sessionsQuery.error}
              fallback="Failed to load your chats."
              onRetry={() => void sessionsQuery.refetch()}
              isRetrying={sessionsQuery.isFetching}
            />
          </div>
        ) : sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No chats yet. Start a new one.
          </p>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === activeId;
            return (
              <div
                key={session.id}
                className={`group flex items-center gap-1 rounded-md px-1 ${
                  isActive ? "bg-accent" : "hover:bg-accent/50"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm text-foreground/80"
                >
                  {session.title}
                </button>
                {/* The age and the Archive button share one grid cell, so the
                button takes the place of the age when it shows. */}
                <div className="grid shrink-0 place-items-center *:col-start-1 *:row-start-1">
                  <span className="pointer-events-none text-xs text-muted-foreground/75 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                    {ageLabel(session.updatedAt)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Archive chat"
                    title="Archive chat"
                    className="text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    disabled={archiveSession.isPending}
                    onClick={() => {
                      const wasActive = session.id === activeId;
                      archiveSession.mutate(session.id, {
                        onSuccess: () => {
                          if (wasActive) onSelect(undefined);
                        },
                      });
                    }}
                  >
                    <Archive />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
