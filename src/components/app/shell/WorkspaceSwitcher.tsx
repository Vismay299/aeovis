"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/projects/ProjectSwitcher.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NAV_GROUPS } from "@/components/app/navigation/items";
import { sectionPathForSwitch } from "@/components/app/navigation/navModel";
import { usePortal } from "@/components/portal/PortalShell";

/** The number of workspaces at which the popup grows a search box. */
const SEARCH_THRESHOLD = 8;

/** One workspace the reader can be in. */
type PortalBrand = {
  brandKey: string;
  role: "owner" | "member";
  display_name: string;
  website: string;
};

/** The host of a workspace's website, without the scheme or a trailing slash. */
function hostOf(website: string | undefined | null): string {
  if (!website) return "";
  return website.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function matchesBrand(brand: PortalBrand, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    brand.display_name.toLowerCase().includes(needle) ||
    hostOf(brand.website).toLowerCase().includes(needle)
  );
}

/**
 * The workspace switcher.
 *
 * Switching keeps the current SECTION — a scan report belongs to one scan, so
 * the reader lands on the scans list of the new workspace rather than on
 * another workspace's scan report.
 */
export function WorkspaceSwitcher({
  onCloseDrawer,
}: {
  onCloseDrawer?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname() || "/portal";
  const { brands, brand, brandKey, setBrandKey } = usePortal();
  const [open, setOpen] = React.useState(false);

  const activeBrand = brand ?? null;

  if (!brands.length) {
    // The loaded switcher's box: a name line, a host line and the settings
    // button's slot, so nothing moves when the workspaces arrive.
    return (
      <div
        className="flex items-stretch rounded-lg border border-sidebar-border bg-card"
        aria-busy
      >
        <div className="flex min-w-0 flex-1 flex-col px-3 py-1.5">
          <span className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-28" />
          </span>
          <span className="flex h-4 items-center">
            <Skeleton className="h-3 w-20" />
          </span>
        </div>
        <div className="w-12 border-l border-sidebar-border" />
      </div>
    );
  }

  const handleSelect = (next: { brandKey: string }) => {
    setOpen(false);
    onCloseDrawer?.();
    if (next.brandKey === brandKey) return;
    setBrandKey(next.brandKey);
    const target = sectionPathForSwitch(NAV_GROUPS, pathname);
    if (target !== pathname) router.push(target);
  };

  return (
    <Combobox
      items={brands}
      value={activeBrand}
      itemToStringLabel={(item) => (item ? item.display_name : "")}
      isItemEqualToValue={(item, value) =>
        Boolean(item && value && item.brandKey === value.brandKey)
      }
      filter={brands.length >= SEARCH_THRESHOLD ? matchesBrand : null}
      autoHighlight
      open={open}
      onOpenChange={setOpen}
      onValueChange={(item) => {
        if (item) handleSelect(item);
      }}
    >
      <div className="flex items-stretch rounded-lg border border-sidebar-border bg-card">
        <ComboboxTrigger
          aria-label="Switch workspace"
          className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-l-lg px-3 py-1.5 text-left hover:bg-accent"
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">
              {activeBrand?.display_name ?? "Select workspace"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {activeBrand
                ? hostOf(activeBrand.website) || activeBrand.role
                : ""}
            </span>
          </span>
        </ComboboxTrigger>
        {activeBrand ? (
          <Button
            nativeButton={false}
            render={
              <Link
                href="/portal/settings"
                aria-label="Workspace settings"
                title="Workspace settings"
                onClick={() => {
                  setOpen(false);
                  onCloseDrawer?.();
                }}
              />
            }
            variant="ghost"
            className="h-auto self-stretch rounded-l-none border-0 border-l border-sidebar-border"
          >
            <Settings className="size-4" />
          </Button>
        ) : null}
      </div>
      <ComboboxContent className="w-(--anchor-width)">
        {brands.length >= SEARCH_THRESHOLD ? (
          <ComboboxInput
            className="w-auto"
            placeholder="Find workspace…"
            aria-label="Filter workspaces"
            showTrigger={false}
          />
        ) : null}
        {brands.length > 0 ? (
          <ComboboxEmpty>No workspaces match.</ComboboxEmpty>
        ) : null}
        <ComboboxList className="max-h-[min(60vh,21rem)]">
          {(item: PortalBrand) => (
            <ComboboxItem key={item.brandKey} value={item}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.display_name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {hostOf(item.website)}
                </span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
