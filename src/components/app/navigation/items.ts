// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/navigation/items.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * The navigation registry.
 *
 * DATA only: the groups, the items and their paths. The decisions about it
 * (who may see an item, which one is active, where a workspace switch lands)
 * live in `navModel.ts`, which is pure and unit-tested.
 *
 * This is the ONE file other features edit to add their own sidebar item.
 * Each feature appends its entry in its own PR, with its own `flag`, so an
 * item whose feature is off stays hidden until the owner turns it on.
 */

import {
  BookOpen,
  Bookmark,
  Globe,
  LayoutDashboard,
  MapPin,
  Link2,
  MessageSquareText,
  PenLine,
  Radar,
  ScanSearch,
  Search,
  Settings,
  Users,
} from "lucide-react";
import type { NavGroup } from "./navModel.ts";
import {
  overviewQueryOptions,
  panelQueryOptions,
  gscQueryOptions,
} from "../../../lib/query/portalQueries.ts";

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "top",
    label: null,
    items: [
      {
        id: "overview",
        label: "Overview",
        href: "/portal",
        icon: LayoutDashboard,
        match: "exact",
        prefetch: overviewQueryOptions,
      },
    ],
  },
  {
    id: "ai",
    label: "AI Visibility",
    items: [
      {
        id: "questions",
        label: "Questions",
        href: "/portal/measurement",
        icon: MessageSquareText,
        // The question history page (F12) is not an item of its own; it lights
        // "Questions" instead.
        activePrefixes: ["/portal/questions"],
        prefetch: panelQueryOptions,
      },
      {
        id: "scans",
        label: "Scans",
        href: "/portal/scans",
        icon: Radar,
        badge: "scan",
      },
    ],
  },
  {
    // F13, F14, F16 and F17 add their items here.
    id: "research",
    label: "Research",
    items: [
      {
        id: "keywords",
        label: "Keywords",
        href: "/portal/keywords",
        icon: Search,
        flag: "keyword_research",
      },
      {
        id: "local",
        label: "Local",
        href: "/portal/local",
        icon: MapPin,
        flag: "local_seo",
      },
      {
        id: "domain",
        label: "Domain",
        href: "/portal/domain",
        icon: Globe,
        flag: "domain_research",
      },
      {
        id: "backlinks",
        label: "Backlinks",
        href: "/portal/backlinks",
        icon: Link2,
        flag: "backlinks",
      },
    ],
  },
  {
    id: "site",
    label: "My Site",
    items: [
      {
        id: "search-console",
        label: "Search Console",
        href: "/portal/search-console",
        icon: Search,
        badge: "gsc",
        prefetch: gscQueryOptions,
      },
      {
        id: "saved-keywords",
        label: "Saved Keywords",
        href: "/portal/keywords/saved",
        icon: Bookmark,
        flag: "keyword_research",
      },
      {
        id: "site-audit",
        label: "Site Audit",
        href: "/portal/audit",
        icon: ScanSearch,
        flag: "site_audit",
      },
    ],
  },
  {
    id: "content",
    label: "Content",
    items: [
      {
        id: "content",
        label: "Content Studio",
        href: "/portal/content",
        icon: PenLine,
        badge: "content",
      },
    ],
  },
  {
    // F07, F22 and F23 add their items here.
    id: "tools",
    label: "AI Tools",
    items: [
      {
        id: "context",
        label: "Context",
        href: "/portal/context",
        icon: BookOpen,
        flag: "project_memory",
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      {
        id: "team",
        label: "Team",
        href: "/portal/team",
        icon: Users,
        ownerOnly: true,
      },
      {
        id: "workspace-settings",
        label: "Workspace settings",
        href: "/portal/settings",
        icon: Settings,
      },
    ],
  },
];
