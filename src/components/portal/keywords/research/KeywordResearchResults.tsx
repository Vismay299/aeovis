// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/page/KeywordResearchResults.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import type { KeywordRow } from "./hooks/useKeywordResearchData";
import { KeywordResearchTable } from "./KeywordResearchTable";

export function KeywordResearchResults(props: { brandKey: string; rows: KeywordRow[]; seed: string; groupKeywords: boolean; selectedKeyword: string; onSelectKeyword: (keyword: string) => void; selectedKeywords: string[]; onToggleKeyword: (keyword: string) => void; mode: string; page: number; pageSize: 50 | 100 | 300 | 500; sort: "searchVolume" | "keywordDifficulty" | "cpc" | "competition" | "keyword"; order: "asc" | "desc"; onSort: (field: "searchVolume" | "keywordDifficulty" | "cpc" | "competition" | "keyword") => void; onPage: (page: number) => void; onPageSize: (size: 50 | 100 | 300 | 500) => void; onSaveSelected: () => void }) {
  return <KeywordResearchTable {...props} />;
}
