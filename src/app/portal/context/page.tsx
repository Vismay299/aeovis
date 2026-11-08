"use client";

import { EmptyState } from "@/components/app/EmptyState";
import { QueryState } from "@/components/app/QueryState";
import { Skeleton } from "@/components/ui/skeleton";
import { usePortal } from "@/components/portal/PortalShell";
import { useProjectContext } from "@/components/portal/context/hooks/useProjectContext";
import { ProjectContextPage } from "@/components/portal/context/ProjectContextPage";

function ContextSkeleton() {
  return (
    <div className="max-w-3xl space-y-8" data-slot="context-skeleton">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-28 w-full rounded-lg" />
      <div className="space-y-6">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
      <div className="space-y-6">
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-36 w-full rounded-lg" />
      </div>
    </div>
  );
}

export default function ContextRoutePage() {
  const { brandKey, user, features } = usePortal();
  const contextQuery = useProjectContext(brandKey || "");

  if (features && features.project_memory === false) {
    return (
      <EmptyState
        title="Feature unavailable"
        description="This page is not available for your workspace yet."
      />
    );
  }

  return (
    <QueryState
      query={contextQuery}
      errorFallback="Context could not be loaded."
      loading={<ContextSkeleton />}
      idle={<ContextSkeleton />}
    >
      {(context) => (
        <ProjectContextPage
          brandKey={brandKey || ""}
          context={context}
          currentUserId={user?.id}
        />
      )}
    </QueryState>
  );
}
