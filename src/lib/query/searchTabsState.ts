// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/search-tabs/useSearchTabs.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { stableStringify } from "./keys.ts";

export const SEARCH_TABS_LIMIT = 20;

export type SearchTab<I> = {
  id: string;
  label: string;
  input: I;
  createdAt: number;
  viewedAt: number | null;
};

export type TabsState<I> = {
  tabs: SearchTab<I>[];
  activeTabId: string | null;
};

export const EMPTY_TABS: TabsState<never> = {
  tabs: [],
  activeTabId: null,
};

export function searchTabsStorageKey(feature: string, brandKey: string): string {
  return `perceev:search-tabs:${feature}:${brandKey}`;
}

export function tabInputKey(input: unknown): string {
  return stableStringify(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseStoredState<I>(
  value: unknown,
  parseInput: (raw: unknown) => I | null
): TabsState<I> {
  if (!isRecord(value) || !Array.isArray(value.tabs)) {
    return EMPTY_TABS as TabsState<I>;
  }

  const tabs = value.tabs
    .flatMap((tab): SearchTab<I>[] => {
      if (!isRecord(tab)) return [];
      if (typeof tab.id !== "string" || tab.id === "") return [];
      if (typeof tab.label !== "string" || tab.label === "") return [];
      if (typeof tab.createdAt !== "number") return [];
      const input = parseInput(tab.input);
      if (input === null || input === undefined) return [];
      return [
        {
          id: tab.id,
          label: tab.label,
          input,
          createdAt: tab.createdAt,
          viewedAt:
            tab.viewedAt === null
              ? null
              : typeof tab.viewedAt === "number"
                ? tab.viewedAt
                : null,
        },
      ];
    })
    .slice(-SEARCH_TABS_LIMIT);

  const activeTabId =
    typeof value.activeTabId === "string" &&
    tabs.some((tab) => tab.id === value.activeTabId)
      ? value.activeTabId
      : null;

  return { tabs, activeTabId };
}

export function appendTabWithEviction<I>(
  tabs: SearchTab<I>[],
  next: SearchTab<I>
): SearchTab<I>[] {
  const kept = tabs.slice(Math.max(0, tabs.length - SEARCH_TABS_LIMIT + 1));
  return [...kept, next];
}

export function openTabState<I>(
  s: TabsState<I>,
  o: { label: string; input: I; id: string; now: number }
): TabsState<I> {
  const inputKey = tabInputKey(o.input);
  const existing = s.tabs.find((tab) => tabInputKey(tab.input) === inputKey);
  if (existing) {
    if (s.activeTabId === existing.id) return s;
    return { ...s, activeTabId: existing.id };
  }

  const next: SearchTab<I> = {
    id: o.id,
    label: o.label,
    input: o.input,
    createdAt: o.now,
    viewedAt: null,
  };

  return {
    tabs: appendTabWithEviction(s.tabs, next),
    activeTabId: next.id,
  };
}

export function setActiveState<I>(
  s: TabsState<I>,
  tabId: string | null
): TabsState<I> {
  if (s.activeTabId === tabId) return s;
  if (tabId !== null && !s.tabs.some((t) => t.id === tabId)) {
    return s;
  }
  return { ...s, activeTabId: tabId };
}

export function closeTabState<I>(
  s: TabsState<I>,
  tabId: string
): {
  state: TabsState<I>;
  closedActive: boolean;
  nextActiveTab: SearchTab<I> | null;
} {
  const index = s.tabs.findIndex((t) => t.id === tabId);
  if (index === -1) {
    return { state: s, closedActive: false, nextActiveTab: null };
  }

  const tabs = s.tabs.filter((t) => t.id !== tabId);
  let activeTabId = s.activeTabId;
  let closedActive = false;
  let nextActiveTab: SearchTab<I> | null = null;

  if (s.activeTabId === tabId) {
    closedActive = true;
    const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
    activeTabId = neighbor?.id ?? null;
    nextActiveTab = neighbor;
  }

  return {
    state: { tabs, activeTabId },
    closedActive,
    nextActiveTab,
  };
}

export function markViewedState<I>(
  s: TabsState<I>,
  tabId: string,
  when: number
): TabsState<I> {
  let changed = false;
  const tabs = s.tabs.map((tab) => {
    if (tab.id !== tabId) return tab;
    if (tab.viewedAt !== null && tab.viewedAt >= when) return tab;
    changed = true;
    return { ...tab, viewedAt: when };
  });

  if (!changed) return s;
  return { ...s, tabs };
}
