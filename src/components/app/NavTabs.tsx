"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/NavTabs.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useId, type ReactNode } from "react";
import { LayoutGroup, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils";

/**
 * A strip of router links styled as tabs, for pages with their own URL.
 *
 * Looks and moves like the locked continuous tabs
 * (`watermelon/continuous-tabs.tsx`): a recessed track, and one filled pill
 * that springs to the current tab. The tabs stay links with `aria-current`,
 * so the URL and history behave exactly as before.
 */
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
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={useId()}>
        <nav
          aria-label={label}
          className={cn(
            "flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-background p-1 shadow-[inset_0_-2px_4px_color-mix(in_oklab,var(--foreground)_6%,transparent)]",
            className,
          )}
        >
          {children}
        </nav>
      </LayoutGroup>
    </MotionConfig>
  );
}

const TAB_CLASS =
  "relative inline-flex h-8 shrink-0 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-200 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[status=active]:text-background data-[status=active]:hover:text-background";

/** The pill behind the current tab; one per strip, so it slides between tabs. */
function ActivePill() {
  return (
    <motion.span
      layoutId="nav-tab-pill"
      aria-hidden
      transition={{ type: "spring", stiffness: 380, damping: 30, mass: 0.9 }}
      className="absolute inset-0 rounded-md bg-foreground shadow-xs"
    />
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
      className={cn(TAB_CLASS, className)}
    >
      {isActive ? <ActivePill /> : null}
      <span className="relative">{children}</span>
    </Link>
  );
}

/**
 * The same tab for a strip whose sections live in the URL's query string
 * rather than its path (e.g. Local SEO's `?tab=`). The caller owns the state.
 */
export function NavTabButton({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-status={active ? "active" : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(TAB_CLASS, className)}
    >
      {active ? <ActivePill /> : null}
      <span className="relative">{children}</span>
    </button>
  );
}
