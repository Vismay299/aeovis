"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/layout/AppShell.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { BackToTop } from "./BackToTop";
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
  overlay,
  children,
}: {
  /** The session is confirmed. Until then the shell renders but loads nothing. */
  ready: boolean;
  /** A full-width strip above the content, such as a refresh warning. */
  banner?: ReactNode;
  /** Floating status for background work, pinned to the top of the content pane. */
  overlay?: ReactNode;
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
        <div className="relative min-h-0 flex-1 overflow-auto" id="app-content">
          {/* Fills with the pane's scroll position (scroll-progress in
              motion.css); zero height so it never shifts the page. */}
          <div aria-hidden className="pointer-events-none sticky top-0 z-40 h-0">
            {/* No overflow clip here: an overflow:hidden box is itself a
                scroll container and would capture scroll(nearest). */}
            <div className="scroll-progress h-0.5 bg-primary" />
          </div>
          {overlay ? (
            // Zero height so the pill floats over the page: it never takes
            // layout space, whether or not there is background work to show.
            <div className="pointer-events-none sticky top-2 z-30 flex h-0 justify-center overflow-visible">
              <div className="pointer-events-auto">{overlay}</div>
            </div>
          ) : null}
          {children}
        </div>
        <BackToTop />
      </SidebarInset>
    </SidebarProvider>
  );
}
