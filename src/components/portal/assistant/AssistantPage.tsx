// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/sam/SamChat.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { notFound } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus, PanelLeft, Wrench } from "lucide-react";
import { usePortal } from "@/components/portal/PortalShell";
import { PageHeader } from "@/components/app/PageHeader";
import { GateCard } from "@/components/app/GateCard";
import { QueryError } from "@/components/app/QueryState";
import { StatusScreen } from "@/components/app/StatusScreen";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Conversation } from "./Conversation.tsx";
import { SessionList } from "./SessionList.tsx";
import {
  assistantConfigQueryOptions,
  assistantSessionQueryOptions,
  useAssistantSessions,
} from "./hooks/useAssistantSessions.ts";

/**
 * The assistant route's content: gates, session selection, and the active
 * conversation. There is no beta gate — the `assistant` feature flag decides.
 * Without a session in the URL the page lands in the most recent session,
 * creating one when the workspace has none.
 */
export function AssistantPage() {
  return (
    <Suspense fallback={<StatusScreen pending />}>
      <AssistantPageContent />
    </Suspense>
  );
}

function AssistantPageContent() {
  const searchParams = useSearchParams();
  const { brandKey, features } = usePortal();
  const activeSessionId = searchParams.get("s") ?? undefined;
  const [sheetOpen, setSheetOpen] = useState(false);

  // The flag decides: with `assistant` off the page does not exist.
  if (features && features.assistant === false) {
    notFound();
  }

  const configQuery = useQuery(assistantConfigQueryOptions(brandKey));

  // The ref (not isPending) guards the auto-create below: React can re-run the
  // effect before the mutation state updates, and it resets on settle so
  // archiving the last chat starts a fresh one.
  const creating = useRef(false);
  // Kept in state: the mutation's own callbacks fire for the create started
  // from the effect below, but the hook's `isError` can miss it and leave the
  // spinner up.
  const [createError, setCreateError] = useState<Error | null>(null);
  const { sessionsQuery, sessions, goToSession, createSession } = useAssistantSessions(brandKey, {
    replace: true,
  });
  const startChat = useCallback(() => {
    creating.current = true;
    setCreateError(null);
    // Inline error via mutateAsync: the landing view below renders createError
    // ("Failed to start a new chat." + Retry), and the mutation's
    // `meta: { errorToast: false }` keeps the shared toast off.
    void createSession
      .mutateAsync(undefined)
      .catch((error: Error) => {
        setCreateError(error);
      })
      .finally(() => {
        creating.current = false;
      });
  }, [createSession]);

  const configured = configQuery.data?.configured === true;
  const ready = configured;

  // Landing without a session: open the most recent one, or start a fresh
  // chat when the workspace has none.
  const firstSessionId = sessions[0]?.id;
  useEffect(() => {
    if (activeSessionId || !ready) return;
    if (firstSessionId) {
      goToSession(firstSessionId);
      return;
    }
    if (!sessionsQuery.isSuccess || creating.current) return;
    startChat();
  }, [activeSessionId, ready, firstSessionId, sessionsQuery.isSuccess, goToSession, startChat]);

  // The list holds every chat the user can open, so an id missing from it is
  // archived, deleted or not theirs. The cached list can predate the link,
  // though (a chat started in another tab), so refetch once before saying so.
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  // Gated on the cached list, not on isSuccess: a failed refetch keeps the
  // old list but leaves the query in error.
  const isMissing =
    activeSessionId !== undefined && !activeSession && sessionsQuery.data !== undefined;
  const [recheckedSessionId, setRecheckedSessionId] = useState<string>();
  const { refetch: refetchSessions } = sessionsQuery;
  useEffect(() => {
    if (!isMissing || recheckedSessionId === activeSessionId) return;
    void refetchSessions().finally(() => setRecheckedSessionId(activeSessionId));
  }, [isMissing, recheckedSessionId, activeSessionId, refetchSessions]);

  const detailQuery = useQuery(
    assistantSessionQueryOptions(brandKey, activeSession && activeSessionId ? activeSessionId : undefined),
  );

  if (!features || configQuery.isPending) {
    return <StatusScreen pending />;
  }

  if (configQuery.isError && !configQuery.data) {
    return (
      <StatusScreen>
        <QueryError
          error={configQuery.error}
          fallback="Could not load the assistant."
          onRetry={() => void configQuery.refetch()}
          isRetrying={configQuery.isFetching}
        />
      </StatusScreen>
    );
  }

  // The assistant cannot answer a turn without a configured language model, so
  // surface setup instructions instead of letting a chat fail mid-stream.
  if (!configured) {
    return (
      <StatusScreen size="lg">
        <GateCard
          icon={Wrench}
          tone="warning"
          title="The assistant is not set up yet"
          description="This deployment has no language model configured for the assistant. Ask Perceev support to finish setup."
          actions={
            <Button variant="secondary" onClick={() => void configQuery.refetch()}>
              Check again
            </Button>
          }
        />
      </StatusScreen>
    );
  }

  if (!activeSessionId) {
    // Sessions are loading or a fresh chat is being created; the effect above
    // redirects into it. Either request can fail, and neither retries itself.
    const loadFailed = sessionsQuery.isError && !sessionsQuery.data;
    return (
      <StatusScreen pending={!loadFailed && !createError}>
        {loadFailed ? (
          <QueryError
            error={sessionsQuery.error}
            fallback="Failed to load your chats."
            onRetry={() => void sessionsQuery.refetch()}
            isRetrying={sessionsQuery.isFetching}
          />
        ) : createError ? (
          <QueryError
            error={createError}
            fallback="Failed to start a new chat."
            onRetry={startChat}
          />
        ) : null}
      </StatusScreen>
    );
  }

  // Never open a chat the list has not confirmed. Wait for the list and the
  // one refetch, show the list error if either fails, else say it is gone.
  if (!activeSession) {
    const confirmed = sessionsQuery.data !== undefined && recheckedSessionId === activeSessionId;
    if (sessionsQuery.isFetching || (!confirmed && !sessionsQuery.isError)) {
      return <StatusScreen pending />;
    }
    if (sessionsQuery.isError) {
      return (
        <StatusScreen>
          <QueryError
            error={sessionsQuery.error}
            fallback="Failed to load your chats."
            onRetry={() => void refetchSessions()}
          />
        </StatusScreen>
      );
    }
    return (
      <StatusScreen description="This chat was archived or does not exist.">
        <Button onClick={() => goToSession()}>Go to your latest chat</Button>
      </StatusScreen>
    );
  }

  const detail = detailQuery.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Assistant"
        description="Ask about your AI visibility, search data and site. Paid lookups always ask you first."
        actions={
          <>
            <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setSheetOpen(true)}>
              <PanelLeft />
              Chats
            </Button>
            <Button variant="secondary" size="sm" pending={createSession.isPending} onClick={startChat}>
              <Plus />
              New chat
            </Button>
          </>
        }
      />
      {/* Body: the session list and the conversation. The offset fills the
          surrounding portal shell (PageFrame padding, the mobile top bar and
          the page header above). */}
      <div className="flex h-[calc(100dvh-16rem)] min-h-[24rem] md:h-[calc(100dvh-11rem)]">
        <div className="hidden w-[260px] shrink-0 border-r border-border pr-2 lg:block">
          <SessionList
            activeId={activeSessionId}
            onSelect={(sessionId) => goToSession(sessionId)}
            onCreate={startChat}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {detailQuery.isPending || !detail ? (
            <StatusScreen pending />
          ) : detailQuery.isError ? (
            <StatusScreen>
              <QueryError
                error={detailQuery.error}
                fallback="Could not load this chat."
                onRetry={() => void detailQuery.refetch()}
                isRetrying={detailQuery.isFetching}
              />
            </StatusScreen>
          ) : (
            <Conversation
              key={activeSessionId}
              sessionId={activeSessionId}
              brandKey={brandKey}
              initial={detail}
            />
          )}
        </div>
      </div>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="flex w-72 flex-col">
          <SheetHeader>
            <SheetTitle>Chats</SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <SessionList
              activeId={activeSessionId}
              onSelect={(sessionId) => {
                setSheetOpen(false);
                goToSession(sessionId);
              }}
              onCreate={() => {
                setSheetOpen(false);
                startChat();
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
