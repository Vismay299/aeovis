"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/search-tabs/useSearchTabs.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  EMPTY_TABS,
  closeTabState,
  markViewedState,
  openTabState,
  parseStoredState,
  searchTabsStorageKey,
  setActiveState,
  tabInputKey,
  type SearchTab,
  type TabsState,
} from "@/shared/query/searchTabsState";

const CHANGE_EVENT = "perceev:search-tabs-change";
const stateCache = new Map<string, TabsState<any>>();

function notify() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

function generateTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useSearchTabs<I>(
  feature: string,
  brandKey: string,
  parseInput: (raw: unknown) => I | null
) {
  const key = searchTabsStorageKey(feature, brandKey);

  const loadState = useCallback((): TabsState<I> => {
    if (typeof window === "undefined") return EMPTY_TABS;
    try {
      const raw = window.sessionStorage.getItem(key);
      if (!raw) return EMPTY_TABS;
      return parseStoredState(JSON.parse(raw), parseInput);
    } catch {
      return EMPTY_TABS;
    }
  }, [key, parseInput]);

  const getSnapshot = useCallback((): TabsState<I> => {
    let state = stateCache.get(key);
    if (!state) {
      state = loadState();
      stateCache.set(key, state);
    }
    return state as TabsState<I>;
  }, [key, loadState]);

  const getServerSnapshot = useCallback((): TabsState<I> => EMPTY_TABS, []);

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const persist = useCallback(
    (next: TabsState<I>) => {
      if (typeof window === "undefined") return;
      try {
        window.sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        // In-memory tabs still work if sessionStorage is unavailable
      }
    },
    [key]
  );

  const update = useCallback(
    (updater: (current: TabsState<I>) => TabsState<I>) => {
      const current = getSnapshot();
      const next = updater(current);
      if (next === current) return;
      stateCache.set(key, next);
      persist(next);
      notify();
    },
    [getSnapshot, key, persist]
  );

  const openTab = useCallback(
    ({ label, input }: { label: string; input: I }) => {
      update((current) =>
        openTabState(current, {
          label,
          input,
          id: generateTabId(),
          now: Date.now(),
        })
      );
    },
    [update]
  );

  const setActiveTab = useCallback(
    (tabId: string | null) => {
      update((current) => setActiveState(current, tabId));
    },
    [update]
  );

  const closeTab = useCallback(
    (tabId: string): { closedActive: boolean; nextActiveTab: SearchTab<I> | null } => {
      let result: { closedActive: boolean; nextActiveTab: SearchTab<I> | null } = {
        closedActive: false,
        nextActiveTab: null,
      };
      update((current) => {
        const closed = closeTabState(current, tabId);
        result = {
          closedActive: closed.closedActive,
          nextActiveTab: closed.nextActiveTab,
        };
        return closed.state;
      });
      return result;
    },
    [update]
  );

  const markTabViewed = useCallback(
    (tabId: string, when = Date.now()) => {
      update((current) => markViewedState(current, tabId, when));
    },
    [update]
  );

  const findMatchingTab = useCallback(
    (input: I): SearchTab<I> | null => {
      const inputKey = tabInputKey(input);
      return (
        state.tabs.find((tab) => tabInputKey(tab.input) === inputKey) ?? null
      );
    },
    [state.tabs]
  );

  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state.activeTabId, state.tabs]
  );

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    openTab,
    setActiveTab,
    closeTab,
    markTabViewed,
    findMatchingTab,
  };
}
