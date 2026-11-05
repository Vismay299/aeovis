// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/navigation/items.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * The navigation model, as pure logic.
 *
 * The registry in `items.ts` is DATA; this module is the DECISION about it:
 * which items a caller may see, which one is active on a given path, and
 * where a workspace switch should land.
 *
 * It has no imports at all — no React, no icons, no router — so `node --test`
 * can cover the decisions directly. `items.ts` adds the icons; the shell
 * renders.
 */

export type NavItem = {
  id: string;
  label: string;
  href: string;
  /** "exact" matches the path and nothing below it; "prefix" also matches below. */
  match?: "exact" | "prefix";
  /** Extra paths that light this item even though they are not below its href. */
  activePrefixes?: readonly string[];
  /** A CLIENT_FEATURES name. The item is hidden unless `features[flag] === true`. */
  flag?: string;
  /** Only an owner sees this item. */
  ownerOnly?: boolean;
  /** The live badge this item carries. */
  badge?: "scan" | "content" | "gsc";
  /** Set by `items.ts`. */
  icon?: unknown;
};

export type NavGroup = {
  id: string;
  /** `null` for a group with no heading, such as the Overview group. */
  label: string | null;
  items: readonly NavItem[];
};

export type NavContext = {
  /** The workspace's feature flags, or nothing yet. */
  features: Record<string, boolean> | null | undefined;
  /** Whether the caller owns the workspace. */
  isOwner: boolean;
};

/** True when `pathname` is `href` or sits below it. */
function pathMatches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * Whether an item is the one the current path belongs to.
 *
 * An item with `match: "exact"` is active only on its own path — Overview
 * would otherwise light up on every page, because every page sits below
 * `/portal`. Every other item matches its own path and everything below it,
 * plus any path in `activePrefixes`.
 */
export function isItemActive(item: NavItem, pathname: string): boolean {
  return matchDepth(item, pathname) >= 0;
}

/**
 * How deep an item's match on `pathname` is: the length of the longest path
 * (its href, or one of its `activePrefixes`) that matched, or -1 when none
 * did. A match through an active prefix is ranked by that prefix, not by the
 * item's href, so a deeper prefix beats a shallower item.
 */
function matchDepth(item: NavItem, pathname: string): number {
  let depth = -1;
  const hrefMatches =
    item.match === "exact" ? pathname === item.href : pathMatches(pathname, item.href);
  if (hrefMatches) depth = item.href.length;
  for (const prefix of item.activePrefixes ?? []) {
    if (pathMatches(pathname, prefix) && prefix.length > depth) depth = prefix.length;
  }
  return depth;
}

/**
 * The groups a caller may see.
 *
 * A flagged item is hidden unless its flag is on; an owner-only item is
 * hidden from members. A group left with no items is dropped entirely, so a
 * group whose features are all off never shows its heading.
 */
export function visibleNavGroups(
  groups: readonly NavGroup[],
  ctx: NavContext
): NavGroup[] {
  const visible: NavGroup[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) => {
      if (item.ownerOnly && !ctx.isOwner) return false;
      if (item.flag && ctx.features?.[item.flag] !== true) return false;
      return true;
    });
    if (items.length === 0) continue;
    visible.push({ ...group, items });
  }
  return visible;
}

/** The deepest-matching item on `pathname`, or `null` when none matches. */
function deepestItem(
  groups: readonly NavGroup[],
  pathname: string
): NavItem | null {
  let best: { item: NavItem; depth: number } | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      const depth = matchDepth(item, pathname);
      if (depth < 0) continue;
      if (best === null || depth > best.depth) best = { item, depth };
    }
  }
  return best === null ? null : best.item;
}

/**
 * The id of the active item, or `null` when the path belongs to none.
 *
 * The DEEPEST match wins: `/portal/scans/scan-1` is the scan report, which
 * sits below the scans item, and the deepest item is the one the reader
 * means. Exactly one row is ever active, so the shell renders from this
 * rather than asking each item on its own.
 */
export function activeNavItemId(
  groups: readonly NavGroup[],
  pathname: string
): string | null {
  return deepestItem(groups, pathname)?.id ?? null;
}

/**
 * Where a workspace switch should land.
 *
 * The section of the active item, so switching workspaces on a scan report
 * lands on the scans list (and on a question, on the questions list) rather
 * than on another workspace's record. A path in no section lands on Overview.
 */
export function sectionPathForSwitch(
  groups: readonly NavGroup[],
  pathname: string
): string {
  return deepestItem(groups, pathname)?.href ?? "/portal";
}
