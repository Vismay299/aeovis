"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/Sidebar.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ComponentType } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { PerceevLogo } from "@/components/app/brand/PerceevLogo";
import { NAV_GROUPS } from "@/components/app/navigation/items";
import { activeNavItemId, visibleNavGroups } from "@/components/app/navigation/navModel";
import type { NavItem } from "@/components/app/navigation/navModel";
import { usePortal } from "@/components/portal/PortalShell";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { AccountMenu } from "./AccountMenu";
import { ScanRunningCard } from "./ScanRunningCard";

/** The nav row: the active row carries an accent and a 3 px brand bar. */
const navButtonClass =
  "relative text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground data-active:before:absolute data-active:before:inset-y-1 data-active:before:left-0 data-active:before:w-[3px] data-active:before:rounded-r-full data-active:before:bg-primary";

/**
 * The sidebar.
 *
 * The registry in `navigation/items.ts` decides what is here; the model in
 * `navigation/navModel.ts` decides what the reader may see and which row is
 * active. Until the session is confirmed the rows render as placeholders, so
 * the sidebar keeps its shape from the first paint.
 */
export function AppSidebar({ ready }: { ready: boolean }) {
  const pathname = usePathname() || "/portal";
  const { setOpenMobile } = useSidebar();
  const { features, isOwner, overview, gsc, scan } = usePortal();

  const groups = visibleNavGroups(NAV_GROUPS, { features, isOwner });
  // One active row: the deepest visible match, never every row that matches.
  const activeId = activeNavItemId(groups, pathname);
  const placeholder = !ready;

  const awaitingReview = (overview?.content_items || []).filter(
    (item: { status?: string }) => item.status === "awaiting_approval"
  ).length;

  const showScanCard =
    scan.active && pathname !== "/portal" && !pathname.startsWith("/portal/scans");

  return (
    <Sidebar variant="inset" collapsible="offcanvas" className="md:!p-0">
      <SidebarHeader className="gap-0 px-3 pb-1 pt-3">
        <Link
          href="/portal"
          onClick={() => setOpenMobile(false)}
          className="px-1 pb-2"
        >
          <PerceevLogo size="md" />
        </Link>
        <WorkspaceSwitcher onCloseDrawer={() => setOpenMobile(false)} />
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label="Main navigation" aria-busy={placeholder || undefined}>
          {groups.map((group) => (
            <SidebarGroup key={group.id} className="py-1">
              {group.label !== null ? (
                <SidebarGroupLabel className="h-7 uppercase tracking-wider text-sidebar-foreground/65">
                  {group.label}
                </SidebarGroupLabel>
              ) : null}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarNavLink
                      key={item.id}
                      item={item}
                      active={item.id === activeId}
                      placeholder={placeholder}
                      badge={navBadge(item, { scan, awaitingReview, gsc })}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>

        {showScanCard ? (
          <div className="mt-2 px-2">
            <ScanRunningCard />
          </div>
        ) : null}
      </SidebarContent>

      <SidebarFooter className="gap-0 border-t border-sidebar-border pb-safe">
        <SidebarMenu>
          <AccountMenu ready={ready} />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

type NavBadgeContext = {
  scan: { active: boolean; percent: number | null };
  awaitingReview: number;
  gsc: { connected?: boolean } | null;
};

/**
 * The live badge a row carries, or null when it carries none.
 *
 * A scan in progress shows its spinner and percentage, the content studio
 * shows the drafts waiting for a decision, and Search Console shows whether
 * it is connected.
 */
function navBadge(
  item: NavItem,
  context: NavBadgeContext
): React.ReactNode {
  if (item.badge === "scan") {
    if (!context.scan.active) return null;
    const percent =
      context.scan.percent === null ? null : Math.round(context.scan.percent);
    return (
      <SidebarMenuBadge className="gap-1">
        <Spinner className="size-3" />
        {percent === null ? null : <span className="tabular-nums">{percent}%</span>}
      </SidebarMenuBadge>
    );
  }
  if (item.badge === "content") {
    if (context.awaitingReview <= 0) return null;
    return (
      <SidebarMenuBadge className="tabular-nums">
        {context.awaitingReview}
      </SidebarMenuBadge>
    );
  }
  if (item.badge === "gsc") {
    if (!context.gsc) return null;
    const connected = context.gsc.connected === true;
    return (
      <SidebarMenuBadge className="w-4 justify-center">
        <span
          aria-hidden="true"
          className={
            connected ? "size-1.5 rounded-full bg-success" : "size-1.5 rounded-full bg-muted-foreground/40"
          }
        />
        <span className="sr-only">{connected ? "Connected" : "Not connected"}</span>
      </SidebarMenuBadge>
    );
  }
  return null;
}

function SidebarNavLink({
  item,
  active,
  placeholder = false,
  badge,
}: {
  item: NavItem;
  active: boolean;
  /** Show the row without its link, while the session is still loading. */
  placeholder?: boolean;
  badge?: React.ReactNode;
}) {
  const { setOpenMobile } = useSidebar();
  const Icon = item.icon as ComponentType<{ className?: string }> | undefined;

  const row = (
    <SidebarMenuButton
      render={<span />}
      isActive={active}
      aria-disabled={placeholder || undefined}
      className={navButtonClass}
    >
      {Icon ? <Icon className="size-4" /> : null}
      <span>{item.label}</span>
    </SidebarMenuButton>
  );

  return (
    <SidebarMenuItem>
      {placeholder ? (
        row
      ) : (
        <Link
          href={item.href}
          onClick={() => setOpenMobile(false)}
          aria-current={active ? "page" : undefined}
        >
          {row}
          {/* The badge is the button's next SIBLING: shadcn positions it with
              `peer-data-[size=…]/menu-button`, which only reaches a later
              sibling of the button that carries the `peer` class. */}
          {badge}
        </Link>
      )}
    </SidebarMenuItem>
  );
}
