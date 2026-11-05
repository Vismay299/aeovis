"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/layout/AppShell.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { PerceevLogo } from "@/components/app/brand/PerceevLogo";

/**
 * The bar that stands in for the sidebar below the md breakpoint: the drawer
 * trigger and the product name.
 */
export function MobileTopBar() {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5 md:hidden">
      <SidebarTrigger aria-label="Toggle sidebar" />
      <Link href="/portal" className="ml-1">
        <PerceevLogo size="sm" />
      </Link>
    </div>
  );
}
