// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/components/DisplayPrimitives.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { KeywordRow } from "./hooks/useKeywordResearchData";

export function AreaTrendChart({ row }: { row: KeywordRow }) {
  if (!row.trend?.length) return null;
  const data = row.trend.map((point) => ({ ...point, label: new Date(point.year, point.month - 1).toLocaleString("en", { month: "short", year: "2-digit" }) }));
  const first = data[0]?.label;
  const last = data[data.length - 1]?.label;
  return <Card><CardHeader><CardTitle>Search Trends</CardTitle><p className="text-xs text-muted-foreground">{first} - {last}</p></CardHeader><CardContent className="h-44 min-w-0"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data}><Tooltip /><Area type="monotone" dataKey="searchVolume" stroke="var(--color-primary)" fill="var(--color-primary)" fillOpacity={0.16} /></AreaChart></ResponsiveContainer></CardContent></Card>;
}
