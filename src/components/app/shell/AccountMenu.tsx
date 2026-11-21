"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/Sidebar.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { LogOut, Settings, User } from "lucide-react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePortal } from "@/components/portal/PortalShell";

/**
 * The account row at the foot of the sidebar: the reader's email, settings
 * and the way out. There is no theme picker: the app has one scheme (Onyx /
 * White, see src/styles/palettes.css) and renders the same whatever is stored.
 */
export function AccountMenu({ ready }: { ready: boolean }) {
  const { setOpenMobile } = useSidebar();
  const { user, signOut } = usePortal();
  const email = user?.email;

  if (!ready || !email) {
    // The account row's slot while the session loads.
    return (
      <SidebarMenuItem>
        <SidebarMenuSkeleton showIcon />
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              className="relative text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              aria-label="Open account menu"
            />
          }
        >
          <User className="size-4" />
          <span className="truncate">{email}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" className="w-56">
          <DropdownMenuItem
            render={
              <Link href="/portal/settings" onClick={() => setOpenMobile(false)} />
            }
          >
            <Settings className="size-4" />
            Workspace settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              void signOut();
            }}
          >
            <LogOut className="size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
