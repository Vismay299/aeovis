"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/NavTabs.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils";

/** A strip of router links styled as tabs, for pages with their own URL. */
export function NavTabs({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn("flex gap-1 border-b border-border", className)}>
      {children}
    </nav>
  );
}

export function NavTab({
  href,
  exact = false,
  children,
  className,
}: {
  href: string;
  exact?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const isActive = exact
    ? pathname === href
    : pathname === href || pathname?.startsWith(href + "/");

  return (
    <Link
      href={href}
      data-status={isActive ? "active" : undefined}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative inline-flex h-9 items-center px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 data-[status=active]:text-foreground",
        "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-foreground after:opacity-0 data-[status=active]:after:opacity-100",
        className
      )}
    >
      {children}
    </Link>
  );
}
