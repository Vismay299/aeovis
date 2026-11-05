"use client";

import { createContext, useContext, type ReactNode } from "react";

export type WorkspaceContextValue = {
  brandKey: string;
  /** `null` until the workspace's features have loaded. */
  features: Record<string, boolean> | null;
  isOwner: boolean;
};

/**
 * The active workspace, for TSX feature components that must not import the
 * portal shell. `null` outside a provider.
 */
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null,
);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue;
  children: ReactNode;
}) {
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}
