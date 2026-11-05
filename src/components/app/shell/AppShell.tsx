"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/layout/AppShell.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { MobileTopBar } from "./MobileTopBar";

/**
 * The app shell: an inset sidebar on the left and a scrolling content pane.
 *
 * The shell renders before the session is confirmed (`ready=false`) and loads
 * nothing until then: the sidebar shows its shape with placeholder rows, so
 * the page does not jump once the workspace arrives.
 */
export function AppShell({
  ready,
  banner,
  children,
}: {
  /** The session is confirmed. Until then the shell renders but loads nothing. */
  ready: boolean;
  /** A full-width strip above the content, such as a refresh warning. */
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarProvider className="h-[100dvh] min-h-0 overflow-hidden">
      <AppSidebar ready={ready} />
      <SidebarInset
        className="min-h-0 overflow-hidden md:!m-0 md:!mt-2 md:!rounded-none md:!rounded-tl-lg md:border-l md:border-t md:border-sidebar-border md:!shadow-none"
        translate="no"
      >
        <MobileTopBar />
        {banner}
        <div className="min-h-0 flex-1 overflow-auto" id="app-content">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
