// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/state/useKeywordResearchController.ts
//   openseo:src/client/features/keywords/state/keywordControllerActions.ts
//   openseo:src/client/features/keywords/state/keywordControllerInternals.ts
//   openseo:src/client/features/keywords/hooks/useKeywordControlsForm.ts
//   openseo:src/client/features/keywords/state/useKeywordOverviewState.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { DEFAULT_LOCATION_CODE, LOCATION_OPTIONS, workspaceMarket } from "@/shared/keyword-locations";
import { usePortal } from "@/components/portal/PortalShell";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { useLocalPref } from "@/components/app/hooks/useLocalPref";
import { useKeywordResearchData, type KeywordRow } from "./useKeywordResearchData";
import { useKeywordSerpAnalysis, type KeywordSerpResponse } from "./useKeywordSerpAnalysis";
import { useKeywordHistory } from "./useKeywordHistory";
import { useKeywordSearchTabs } from "./useKeywordSearchTabs";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { isApiError } from "@/lib/query/fetchJson";
import { MAX_KEYWORDS_PER_SUBMIT } from "@/shared/keywords";

const searchSchema = z.object({
  q: z.string(),
  loc: z.number().int().positive(),
  locName: z.string(),
  kLimit: z.union([z.literal(150), z.literal(300), z.literal(500)]),
  mode: z.enum(["auto", "related", "suggestions", "ideas"]),
  cs: z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean()),
  grp: z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean()),
  sort: z.enum(["searchVolume", "keywordDifficulty", "cpc", "competition", "keyword"]),
  order: z.enum(["asc", "desc"]),
});

const defaults = {
  q: "", loc: DEFAULT_LOCATION_CODE, locName: "", kLimit: 150 as const,
  mode: "auto" as const, cs: false, grp: false, sort: "searchVolume" as const, order: "desc" as const,
};

export function useKeywordResearchController() {
  const { brandKey, brand, features } = usePortal();
  const market = workspaceMarket({ website_host: brand?.website });
  const [locationPref, setLocationPref] = useLocalPref("keyword-location", z.number().int().positive(), market.locationCode, { brandKey });
  const [params, setParams] = useUrlSearchState(searchSchema, { ...defaults, loc: locationPref });
  const [draft, setDraft] = useState(params.q);
  const [researchLiveMode, setResearchLiveMode] = useState(false);
  const [researchApprovedMaxUsd, setResearchApprovedMaxUsd] = useState<number | undefined>();
  const [serpLiveMode, setSerpLiveMode] = useState(false);
  const [serpApproval, setSerpApproval] = useState<{ keyword: string; depth: 20 | 100; maxUsd: number } | undefined>();
  const [serpDepth, setSerpDepth] = useState<20 | 100>(20);
  const [serpTop20Result, setSerpTop20Result] = useState<KeywordSerpResponse | undefined>();
  const [selectedKeyword, setSelectedKeyword] = useState(params.q);
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState("keywords");
  const [pageSize, setPageSize] = useState<50 | 100 | 300 | 500>(50);
  const [page, setPage] = useState(1);
  const [priceChanged, setPriceChanged] = useState<{ approvedMaxUsd: number; quote: NonNullable<ReturnType<typeof usePriceQuote>["data"]> } | null>(null);
  const lastHistoryKey = useRef("");
  const history = useKeywordHistory(brandKey);
  const tabs = useKeywordSearchTabs(brandKey);

  useEffect(() => { setDraft(params.q); setSelectedKeyword(params.q); }, [params.q]);
  useEffect(() => {
    setResearchLiveMode(false);
    setResearchApprovedMaxUsd(undefined);
    setSerpLiveMode(false);
    setSerpApproval(undefined);
    setSerpDepth(20);
    setSerpTop20Result(undefined);
  }, [brandKey]);

  const location = LOCATION_OPTIONS.find((item) => item.code === params.loc) ?? LOCATION_OPTIONS[0];
  const researchQuote = usePriceQuote({
    brandKey,
    action: "keywords.research.run",
    input: {
      keyword: params.q || draft.split("\n")[0] || "keyword",
      locationCode: params.loc || locationPref,
      languageCode: location?.languageCode ?? "en",
      resultLimit: params.kLimit,
      mode: params.mode,
      clickstream: params.cs,
      groupKeywords: params.grp,
    },
  }, { enabled: Boolean(brandKey) });

  const queryInput = useMemo(() => params.q ? ({
    brand_key: brandKey,
    keyword: params.q,
    locationCode: params.loc || locationPref,
    languageCode: location?.languageCode ?? "en",
    resultLimit: params.kLimit,
    mode: params.mode,
    clickstream: params.cs,
    groupKeywords: params.grp,
    cacheOnly: !researchLiveMode,
    ...(researchLiveMode && researchApprovedMaxUsd !== undefined ? { maxUsd: researchApprovedMaxUsd } : {}),
  }) : null, [brandKey, location?.languageCode, locationPref, params, researchApprovedMaxUsd, researchLiveMode]);
  const research = useKeywordResearchData(queryInput);
  const rows: KeywordRow[] = research.data?.rows ?? [];

  useEffect(() => {
    if (!params.q || !research.data || research.data.notCached || research.isError) return;
    const key = `${brandKey}:${params.q}:${params.loc}`;
    if (lastHistoryKey.current === key) return;
    lastHistoryKey.current = key;
    const entry = { keyword: params.q, locationCode: params.loc, locationName: params.locName || null };
    history.addSearch(entry);
    tabs.openTab({ label: params.locName ? `${params.q} · ${params.locName}` : params.q, input: entry });
  }, [brandKey, history.addSearch, params.loc, params.locName, params.q, research.data, research.isError, tabs.openTab]);

  const serpQuote = usePriceQuote({
    brandKey,
    action: "keywords.serp.run",
    input: { keyword: selectedKeyword || params.q || "keyword", locationCode: params.loc, languageCode: location?.languageCode ?? "en", depth: 20 },
  }, { enabled: Boolean(brandKey && (selectedKeyword || params.q)) });
  const serpDeepQuote = usePriceQuote({
    brandKey,
    action: "keywords.serp.run",
    input: { keyword: selectedKeyword || params.q || "keyword", locationCode: params.loc, languageCode: location?.languageCode ?? "en", depth: 100 },
  }, { enabled: Boolean(brandKey && (selectedKeyword || params.q)) });
  const serpMaxUsd = researchQuote.data?.lines.find((line) => /serp/i.test(line.label))?.totalUsd
    ?? serpQuote.data?.totalUsd;
  const serpDeepMaxUsd = serpDeepQuote.data?.totalUsd;
  const approvedSerpMaxUsd = serpApproval?.keyword === selectedKeyword && serpApproval.depth === serpDepth
    ? serpApproval.maxUsd
    : (serpDepth === 20 ? serpMaxUsd : serpDeepMaxUsd);
  const serpInput = selectedKeyword && rows.length && !research.data?.notCached ? {
    brand_key: brandKey,
    keyword: selectedKeyword,
    locationCode: params.loc,
    languageCode: location?.languageCode ?? "en",
    depth: serpDepth,
    cacheOnly: !serpLiveMode,
    ...(serpLiveMode && approvedSerpMaxUsd !== undefined ? { maxUsd: approvedSerpMaxUsd } : {}),
  } : null;
  const serp = useKeywordSerpAnalysis(serpInput);

  useEffect(() => {
    setSerpDepth(20);
    setSerpTop20Result(undefined);
  }, [selectedKeyword]);
  useEffect(() => {
    if (serpDepth === 20 && serp.data?.items?.length) setSerpTop20Result(serp.data);
  }, [serp.data, serpDepth]);

  const runSearch = (maxUsd: number) => {
    const keywords = draft.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, MAX_KEYWORDS_PER_SUBMIT);
    const keyword = keywords[0];
    if (!keyword) return;
    for (const tabKeyword of keywords) {
      const input = { keyword: tabKeyword, locationCode: locationPref, locationName: params.locName || null };
      tabs.openTab({ label: params.locName ? `${tabKeyword} · ${params.locName}` : tabKeyword, input });
    }
    const seedSerpCeiling = researchQuote.data?.lines.find((line) => /serp/i.test(line.label))?.totalUsd;
    setResearchApprovedMaxUsd(maxUsd);
    setResearchLiveMode(true);
    setSerpDepth(20);
    if (seedSerpCeiling !== undefined) {
      setSerpApproval({ keyword, depth: 20, maxUsd: seedSerpCeiling });
      setSerpLiveMode(true);
    }
    setSelectedKeyword(keyword);
    setPage(1);
    setSelectedKeywords([]);
    setParams({ q: keyword, loc: locationPref, locName: "", kLimit: params.kLimit, mode: params.mode, cs: params.cs, grp: params.grp }, { replace: false });
  };

  const runSerp = (maxUsd: number) => {
    setSerpDepth(20);
    setSerpApproval({ keyword: selectedKeyword, depth: 20, maxUsd });
    setSerpLiveMode(true);
  };

  const runSerpDeep = (maxUsd: number) => {
    setSerpDepth(100);
    setSerpApproval({ keyword: selectedKeyword, depth: 100, maxUsd });
    setSerpLiveMode(true);
  };

  const showSerpTop20 = () => setSerpDepth(20);

  const retryResearch = () => { void research.refetch(); };
  const handleResearchError = (error: unknown) => {
    if (isApiError(error) && error.code === "price_changed" && researchQuote.data) {
      setPriceChanged({ approvedMaxUsd: researchApprovedMaxUsd ?? 0, quote: researchQuote.data });
    }
  };
  useEffect(() => { if (research.error) handleResearchError(research.error); }, [research.error]);

  const toggleSelected = (keyword: string) => setSelectedKeywords((current) =>
    current.includes(keyword) ? current.filter((item) => item !== keyword) : [...current, keyword],
  );
  const clearSelectedKeywords = () => setSelectedKeywords([]);
  const featureEnabled = features?.keyword_research === true;

  return {
    brandKey, brand, featureEnabled, params, setParams, draft, setDraft, locationPref,
    setLocationPref, location, research, researchQuote, rows, selectedKeyword,
    setSelectedKeyword, selectedKeywords, toggleSelected, clearSelectedKeywords, filtersOpen, setFiltersOpen,
    mobileTab, setMobileTab, pageSize, setPageSize, page, setPage,
    liveMode: researchLiveMode, runSearch, runSerp, runSerpDeep, showSerpTop20,
    serp, serpQuote, serpDeepQuote, serpMaxUsd, serpDeepMaxUsd, serpDepth, serpTop20Result, retryResearch,
    priceChanged, setPriceChanged, history, tabs,
  };
}
