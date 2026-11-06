"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/search-tabs/useSearchTabNavigation.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { tabInputKey, type SearchTab } from "@/lib/query/searchTabsState";
import { useSearchTabs } from "./useSearchTabs";

export type UseSearchTabNavigationArgs<I> = {
  feature: string;
  brandKey: string;
  parseInput: (raw: unknown) => I | null;
  urlInput: I | null;
  getLabel: (input: I) => string;
  navigateToInput: (input: I | null) => void;
};

export function useSearchTabNavigation<I>({
  feature,
  brandKey,
  parseInput,
  urlInput,
  getLabel,
  navigateToInput,
}: UseSearchTabNavigationArgs<I>) {
  const closedInputKeysRef = useRef<Set<string>>(new Set());
  const tabs = useSearchTabs<I>(feature, brandKey, parseInput);
  const {
    activeTabId,
    closeTab,
    findMatchingTab,
    markTabViewed,
    openTab,
    setActiveTab,
  } = tabs;

  useEffect(() => {
    const urlKey = urlInput ? tabInputKey(urlInput) : "";
    if (closedInputKeysRef.current.has(urlKey)) {
      return;
    }
    closedInputKeysRef.current.clear();

    if (!urlInput) {
      setActiveTab(null);
      return;
    }

    const existing = findMatchingTab(urlInput);
    if (existing) {
      if (activeTabId !== existing.id) {
        setActiveTab(existing.id);
      }
      return;
    }

    openTab({
      label: getLabel(urlInput),
      input: urlInput,
    });
  }, [activeTabId, findMatchingTab, getLabel, openTab, setActiveTab, urlInput]);

  const selectTab = useCallback(
    (tab: SearchTab<I>) => {
      closedInputKeysRef.current.delete(tabInputKey(tab.input));
      setActiveTab(tab.id);
      navigateToInput(tab.input);
    },
    [navigateToInput, setActiveTab]
  );

  const closeSearchTab = useCallback(
    (tabId: string) => {
      const closingTab = tabs.tabs.find((tab) => tab.id === tabId) ?? null;
      if (closingTab) {
        closedInputKeysRef.current.add(tabInputKey(closingTab.input));
      }
      const result = closeTab(tabId);
      if (result.closedActive) {
        navigateToInput(result.nextActiveTab?.input ?? null);
      }
    },
    [closeTab, navigateToInput, tabs.tabs]
  );

  const openSearchTab = useCallback(
    (input: I) => {
      closedInputKeysRef.current.delete(tabInputKey(input));
      openTab({
        label: getLabel(input),
        input,
      });
    },
    [getLabel, openTab]
  );

  const visibleTabs = useMemo(
    () =>
      tabs.tabs.filter(
        (tab) => !closedInputKeysRef.current.has(tabInputKey(tab.input))
      ),
    [tabs.tabs]
  );

  return {
    activeTabId: tabs.activeTabId,
    tabs: visibleTabs,
    closeTab: closeSearchTab,
    markTabViewed,
    openTab: openSearchTab,
    selectTab,
    setActiveTab,
  };
}
