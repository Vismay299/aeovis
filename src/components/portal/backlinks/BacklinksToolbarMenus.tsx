"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksToolbarMenus.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { ChevronDown, Gauge, Link2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { DEFAULT_BACKLINKS_SPAM_THRESHOLD } from "@/shared/backlinks";

export function BacklinksBestLinksMenu({
  hideSpam,
  onHideSpamChange,
}: {
  hideSpam: boolean;
  onHideSpamChange: (hideSpam: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
        <Link2 data-icon="inline-start" />
        Best links: {hideSpam ? "On" : "Off"}
        <ChevronDown data-icon="inline-end" className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuRadioGroup
          value={hideSpam ? "best" : "all"}
          onValueChange={(value) => onHideSpamChange(value === "best")}
        >
          <DropdownMenuRadioItem value="best">
            <span>
              <span className="block">Best links only</span>
              <span className="block text-xs text-muted-foreground">
                Scores below {DEFAULT_BACKLINKS_SPAM_THRESHOLD} or unknown
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="all">
            <span>
              <span className="block">All links (spammy included)</span>
              <span className="block text-xs text-muted-foreground">
                Includes scores {DEFAULT_BACKLINKS_SPAM_THRESHOLD} or higher
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BacklinksActionsMenu({
  isLoadingRatings,
  loadRatings,
  ratableDomains,
}: {
  isLoadingRatings: boolean;
  loadRatings: (domains: string[]) => void | Promise<void>;
  ratableDomains: string[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Backlinks table actions"
            title="Backlinks table actions"
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          onClick={() => void loadRatings(ratableDomains)}
          disabled={isLoadingRatings}
          title="Look up Ahrefs Domain Rating for each domain in the table"
        >
          {isLoadingRatings ? <Spinner /> : <Gauge />}
          Ahrefs DR
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
