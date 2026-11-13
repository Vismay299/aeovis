// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/AuditResultsTableFilters.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the pages table filters: search, status, crawl result, word
// and response-time ranges, and missing alt.

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataTableFilterPanel,
  DataTableFilterToggle,
  DataTableRangeFilter,
  DataTableToolbar,
} from "@/components/app/table/DataTableToolbar";

export type PagesSearchState = {
  q: string;
  status: "all" | "ok" | "redirect" | "error" | "missing";
  fetchClass: "all" | "ok" | "blocked" | "rate_limited" | "error";
  minWords?: number;
  maxWords?: number;
  minResponseMs?: number;
  maxResponseMs?: number;
  missingAlt: "all" | "yes" | "no";
  issueType: string;
  sort: "url" | "status" | "title" | "h1" | "words" | "images" | "speed";
  dir: "asc" | "desc";
  offset: number;
  limit: number;
};

export const PAGES_DEFAULTS: PagesSearchState = {
  q: "",
  status: "all",
  fetchClass: "all",
  minWords: undefined,
  maxWords: undefined,
  minResponseMs: undefined,
  maxResponseMs: undefined,
  missingAlt: "all",
  issueType: "",
  sort: "url",
  dir: "asc",
  offset: 0,
  limit: 100,
};

export function PagesFilters({
  state,
  setState,
  activeCount,
  total,
  actions,
}: {
  state: PagesSearchState;
  setState: (patch: Partial<PagesSearchState>) => void;
  activeCount: number;
  total: number;
  actions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-border">
      <DataTableToolbar actions={actions}>
        <DataTableFilterToggle
          open={open}
          activeCount={activeCount}
          onToggle={() => setOpen((value) => !value)}
        />
        <span className="text-sm text-muted-foreground tabular-nums">
          {`${total.toLocaleString("en-US")} pages`}
        </span>
      </DataTableToolbar>

      {open ? (
        <DataTableFilterPanel
          activeCount={activeCount}
          onReset={() => {
            setState(PAGES_DEFAULTS);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="audit-pages-q">Search</Label>
              <Input
                id="audit-pages-q"
                placeholder="Search URL, title or description"
                value={state.q}
                onChange={(event) =>
                  setState({ q: event.target.value, offset: 0 })
                }
              />
            </div>

            <div className="space-y-1">
              <Label>Status</Label>
              <Select
                value={state.status}
                onValueChange={(value) =>
                  setState({
                    status: value as PagesSearchState["status"],
                    offset: 0,
                  })
                }
              >
                <SelectTrigger aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="ok">OK (2xx)</SelectItem>
                  <SelectItem value="redirect">Redirect (3xx)</SelectItem>
                  <SelectItem value="error">Error (4xx+)</SelectItem>
                  <SelectItem value="missing">Missing</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Crawl result</Label>
              <Select
                value={state.fetchClass}
                onValueChange={(value) =>
                  setState({
                    fetchClass: value as PagesSearchState["fetchClass"],
                    offset: 0,
                  })
                }
              >
                <SelectTrigger aria-label="Crawl result">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All results</SelectItem>
                  <SelectItem value="ok">OK</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                  <SelectItem value="rate_limited">Rate limited</SelectItem>
                  <SelectItem value="error">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DataTableRangeFilter
              label="Words"
              min={{
                value: state.minWords ?? "",
                onChange: (event) =>
                  setState({
                    minWords:
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value),
                    offset: 0,
                  }),
              }}
              max={{
                value: state.maxWords ?? "",
                onChange: (event) =>
                  setState({
                    maxWords:
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value),
                    offset: 0,
                  }),
              }}
            />

            <DataTableRangeFilter
              label="Response time (ms)"
              min={{
                value: state.minResponseMs ?? "",
                onChange: (event) =>
                  setState({
                    minResponseMs:
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value),
                    offset: 0,
                  }),
              }}
              max={{
                value: state.maxResponseMs ?? "",
                onChange: (event) =>
                  setState({
                    maxResponseMs:
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value),
                    offset: 0,
                  }),
              }}
            />

            <div className="space-y-1">
              <Label>Missing alt</Label>
              <Select
                value={state.missingAlt}
                onValueChange={(value) =>
                  setState({
                    missingAlt: value as PagesSearchState["missingAlt"],
                    offset: 0,
                  })
                }
              >
                <SelectTrigger aria-label="Missing alt">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All pages</SelectItem>
                  <SelectItem value="yes">Has missing alt</SelectItem>
                  <SelectItem value="no">No missing alt</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </DataTableFilterPanel>
      ) : null}
    </div>
  );
}
