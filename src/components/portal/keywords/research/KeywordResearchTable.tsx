// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordResearchTable.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMemo, useState } from "react";
import { z } from "zod";
import { useLocalPref } from "@/components/app/hooks/useLocalPref";
import { useExportRows } from "@/components/app/export/useExportRows";
import { DataTableFilterToggle, DataTableToolbar } from "@/components/app/table/DataTableToolbar";
import { ScoreBadge } from "@/components/app/table/ScoreBadge";
import { ExportMenu } from "@/components/app/ExportMenu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { groupSharedVolumeRows, keywordResearchPageEnds } from "@/shared/keyword-filtering";
import { IntentBadge } from "./IntentBadge";
import { KeywordResearchFilters, type KeywordFilters } from "./KeywordResearchFilters";
import { KeywordResearchPagination } from "./KeywordResearchPagination";
import type { KeywordRow } from "./hooks/useKeywordResearchData";

const filterValuesSchema = z.object({
  include: z.string(),
  exclude: z.string(),
  minVolume: z.string(),
  maxVolume: z.string(),
  minCpc: z.string(),
  maxCpc: z.string(),
  minDifficulty: z.string(),
  maxDifficulty: z.string(),
  intent: z.string(),
});

const emptyFilters: KeywordFilters = {
  include: "", exclude: "", minVolume: "", maxVolume: "", minCpc: "", maxCpc: "",
  minDifficulty: "", maxDifficulty: "", intent: "",
};

function unknown(value: number | null) {
  return value == null ? "—" : value.toLocaleString();
}

type Props = {
  brandKey: string;
  rows: KeywordRow[];
  seed: string;
  groupKeywords: boolean;
  selectedKeyword: string;
  onSelectKeyword: (keyword: string) => void;
  selectedKeywords: string[];
  onToggleKeyword: (keyword: string) => void;
  mode: string;
  page: number;
  pageSize: 50 | 100 | 300 | 500;
  onPage: (page: number) => void;
  onPageSize: (size: 50 | 100 | 300 | 500) => void;
  onSaveSelected: () => void;
};

export function KeywordResearchTable({
  brandKey,
  rows,
  seed,
  groupKeywords,
  selectedKeyword,
  onSelectKeyword,
  selectedKeywords,
  onToggleKeyword,
  mode,
  page,
  pageSize,
  onPage,
  onPageSize,
  onSaveSelected,
}: Props) {
  const [filters, setFilters] = useLocalPref(
    "keyword-filters",
    filterValuesSchema,
    emptyFilters,
    { brandKey },
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const exportRows = useExportRows();

  const filteredRows = useMemo(() => rows.filter((row) => {
    const keyword = row.keyword.toLowerCase();
    const include = filters.include.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    const exclude = filters.exclude.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (include.length && !include.every((term) => keyword.includes(term))) return false;
    if (exclude.some((term) => keyword.includes(term))) return false;
    if (filters.minVolume && (row.searchVolume == null || row.searchVolume < Number(filters.minVolume))) return false;
    if (filters.maxVolume && (row.searchVolume == null || row.searchVolume > Number(filters.maxVolume))) return false;
    if (filters.minCpc && (row.cpc == null || row.cpc < Number(filters.minCpc))) return false;
    if (filters.maxCpc && (row.cpc == null || row.cpc > Number(filters.maxCpc))) return false;
    if (filters.minDifficulty && (row.keywordDifficulty == null || row.keywordDifficulty < Number(filters.minDifficulty))) return false;
    if (filters.maxDifficulty && (row.keywordDifficulty == null || row.keywordDifficulty > Number(filters.maxDifficulty))) return false;
    if (filters.intent && row.intent !== filters.intent) return false;
    return true;
  }), [filters, rows]);

  const displayRows = useMemo(
    () => groupSharedVolumeRows(filteredRows, seed, groupKeywords),
    [filteredRows, groupKeywords, seed],
  );
  const pageEnds = useMemo(
    () => keywordResearchPageEnds(displayRows, pageSize),
    [displayRows, pageSize],
  );
  const pageStart = page <= 1 ? 0 : pageEnds[page - 2] ?? displayRows.length;
  const pageEnd = pageEnds[page - 1] ?? displayRows.length;
  const pageRows = displayRows.slice(pageStart, pageEnd);
  const activeCount = Object.values(filters).filter(Boolean).length;
  const label = selectedKeywords.length
    ? `${selectedKeywords.length} selected`
    : filteredRows.length === rows.length
      ? `Showing ${rows.length} keywords`
      : `Showing ${filteredRows.length} of ${rows.length} keywords`;
  const changeFilters = (next: KeywordFilters) => {
    setFilters(next);
    onPage(1);
  };
  const clearFilters = () => {
    setFilters(emptyFilters);
    onPage(1);
  };
  const exportAction = (format: "csv" | "sheets") => void exportRows({
    format,
    feature: "keywords",
    headers: ["Keyword", "Volume", "CPC", "Comp.", "Score", "Intent"],
    rows: (selectedKeywords.length ? rows.filter((row) => selectedKeywords.includes(row.keyword)) : filteredRows)
      .map((row) => [row.keyword, row.searchVolume, row.cpc, row.competition, row.keywordDifficulty, row.intent]),
    filename: "keyword-research",
    records: rows,
  });

  return <Card className="min-w-0">
    <DataTableToolbar actions={<div className="flex items-center gap-2"><DataTableFilterToggle open={filtersOpen} activeCount={activeCount} onToggle={() => setFiltersOpen(!filtersOpen)} /><ExportMenu actions={["sheets", "csv"]} onExport={exportAction} /></div>}>
      <span aria-live="polite" className="text-sm text-muted-foreground">{label}</span>
      {selectedKeywords.length ? <Button size="sm" onClick={onSaveSelected}>Save Keywords</Button> : null}
      {selectedKeywords.length ? <Button variant="ghost" size="sm" onClick={() => selectedKeywords.forEach(onToggleKeyword)}>Clear</Button> : null}
    </DataTableToolbar>
    {mode !== "auto" ? <p className="border-b border-border bg-muted/30 px-4 py-2 text-sm">No exact match for “{seed}”. Showing closest related keywords instead.</p> : null}
    {filtersOpen ? <KeywordResearchFilters value={filters} onChange={changeFilters} onClear={clearFilters} /> : null}
    {filteredRows.length === 0 ? <div className="p-8 text-center"><p className="font-medium">No results match these filters</p><Button variant="link" onClick={clearFilters}>Clear filters</Button></div> : <div className="w-full overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border text-muted-foreground"><th className="w-10 p-3"><Checkbox aria-label="Select all keywords" checked={pageRows.length > 0 && pageRows.every((row) => selectedKeywords.includes(row.keyword))} onCheckedChange={(value) => pageRows.forEach((row) => { if (Boolean(value) !== selectedKeywords.includes(row.keyword)) onToggleKeyword(row.keyword); })} /></th><th className="p-3">Keyword</th><th className="p-3">Volume</th><th className="p-3"><span title="Cost per click in USD.">CPC</span></th><th className="p-3"><span title="Paid-search competition from Google Ads (0-1): higher means more advertisers bidding.">Comp.</span></th><th className="p-3"><span title="Organic ranking difficulty (0-100): higher means harder to reach Google's top 10.">Score</span></th><th className="p-3">Intent</th></tr></thead><tbody>{pageRows.map((row) => <tr key={row.keyword} title={row.parentKeyword ? `${row.keyword}: matching reported volume with ${row.parentKeyword}. Shared volumes may overlap.` : undefined} className={`border-b border-border/70 hover:bg-muted/40 ${selectedKeyword === row.keyword ? "bg-muted/50" : ""}`}><td className="p-3"><Checkbox aria-label={`Select ${row.keyword}`} checked={selectedKeywords.includes(row.keyword)} onCheckedChange={() => onToggleKeyword(row.keyword)} /></td><td className="p-3"><button className={`text-left font-medium hover:underline ${row.parentKeyword ? "ml-6" : ""}`} onClick={() => onSelectKeyword(row.keyword)}>{row.parentKeyword ? <span aria-hidden="true">↳ </span> : null}{row.keyword}</button></td><td className="p-3 tabular-nums">{unknown(row.searchVolume)}</td><td className="p-3 tabular-nums">{row.cpc == null ? "—" : `$${row.cpc.toFixed(2)}`}</td><td className="p-3 tabular-nums">{row.competition == null ? "—" : row.competition.toFixed(2)}</td><td className="p-3"><ScoreBadge value={row.keywordDifficulty} /></td><td className="p-3"><IntentBadge intent={row.intent} /></td></tr>)}</tbody></table></div>}
    {filteredRows.length ? <KeywordResearchPagination page={page} pageSize={pageSize} total={displayRows.length} pageEnds={pageEnds} onPage={onPage} onPageSize={(size) => { onPageSize(size); onPage(1); }} /> : null}
  </Card>;
}
