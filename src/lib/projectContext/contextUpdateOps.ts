// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/project-context/services/contextUpdateOps.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import {
  CUSTOM_SECTION_KEY_PREFIX,
  MAX_COMPETITORS,
  MAX_CUSTOM_SECTIONS,
  MAX_KEY_PAGES,
  PROSE_MAX_CHARS,
  type ContextAuthor,
  type KeyPageRole,
  type ProjectCompetitorSource,
  type ProjectContextUpdate,
  type ProjectResearchKind,
} from "../../shared/project-context.ts";
import { normalizeCompetitorDomain, normalizeKeyPageUrl, normalizeResearchKey } from "./normalize.ts";

export type ResolvedOp =
  | { kind: "upsert_section" | "insert_section_if_missing"; key: string; title: string | null; content: string }
  | { kind: "delete_section"; key: string }
  | {
      kind: "upsert_competitors" | "insert_competitors_if_none";
      rows: {
        domain: string;
        name: string | null;
        notes: string | null;
        source: ProjectCompetitorSource;
        source_url: string | null;
      }[];
    }
  | { kind: "delete_competitors"; domains: string[] }
  | {
      kind: "upsert_key_pages";
      rows: { url: string; role: KeyPageRole | null; topic: string | null; notes: string | null }[];
    }
  | { kind: "delete_key_pages"; urls: string[] }
  | {
      kind: "append_research_log";
      summary: string;
      research_kind: ProjectResearchKind;
      research_key: string | null;
      spend_usd: number | null;
      job_id: string | null;
    }
  | { kind: "delete_research_log"; ids: string[] };

type CurrentContext = { customKeys: Set<string>; domains: Set<string>; urls: Set<string>; ownHost: string };

function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  return [...new Map(rows.map((row) => [key(row), row])).values()];
}

function assertProseFits(content: string): void {
  if (content.length > PROSE_MAX_CHARS) {
    throw new AppError(
      400,
      "context_invalid",
      "Sections are capped at 4,000 characters. Summarize instead of pasting.",
    );
  }
}

function rejectedUpdate(index: number, error: unknown): AppError {
  const message = error instanceof Error ? error.message : "The update is invalid.";
  return new AppError(
    400,
    "context_invalid",
    `updates[${index}] was rejected (nothing in this batch was applied): ${message}`,
    { details: { index } },
  );
}

export function resolveContextUpdates(
  updates: ProjectContextUpdate[],
  current: CurrentContext,
  opts?: { competitorSource?: ProjectCompetitorSource },
): ResolvedOp[] {
  const customKeys = new Set(current.customKeys);
  const domains = new Set(current.domains);
  const urls = new Set(current.urls);
  const ownHost = current.ownHost.trim().toLowerCase().replace(/^www\./, "");
  const resolved: ResolvedOp[] = [];
  const competitorSource = opts?.competitorSource ?? "manual";

  updates.forEach((update, index) => {
    try {
      if ("section" in update) {
        const content = update.content.trim();
        assertProseFits(content);
        resolved.push(
          content === ""
            ? { kind: "delete_section", key: update.section }
            : { kind: "upsert_section", key: update.section, title: null, content },
        );
        return;
      }

      if ("customSection" in update) {
        const key = `${CUSTOM_SECTION_KEY_PREFIX}${update.customSection}`;
        const content = update.content.trim();
        assertProseFits(content);
        if (content === "") {
          resolved.push({ kind: "delete_section", key });
          customKeys.delete(key);
          return;
        }
        if (!customKeys.has(key) && customKeys.size >= MAX_CUSTOM_SECTIONS) {
          throw new AppError(400, "context_cap", "A workspace can hold 20 custom sections. Delete one first.");
        }
        resolved.push({ kind: "upsert_section", key, title: update.title ?? null, content });
        customKeys.add(key);
        return;
      }

      if ("deleteCustomSection" in update) {
        const key = `${CUSTOM_SECTION_KEY_PREFIX}${update.deleteCustomSection}`;
        resolved.push({ kind: "delete_section", key });
        customKeys.delete(key);
        return;
      }

      if ("addCompetitors" in update) {
        const rows = dedupeBy(
          update.addCompetitors.map((competitor) => {
            const domain = normalizeCompetitorDomain(competitor.domain);
            if (domain === ownHost) {
              throw new AppError(400, "context_invalid", "Your own website cannot be a competitor.");
            }
            return {
              domain,
              name: competitor.name ?? null,
              notes: competitor.notes ?? null,
              source: competitorSource,
              source_url: null,
            };
          }),
          (row) => row.domain,
        );
        const additions = rows.filter((row) => !domains.has(row.domain)).length;
        if (domains.size + additions > MAX_COMPETITORS) {
          throw new AppError(400, "context_cap", "A workspace can track 100 competitors. Remove some first.");
        }
        resolved.push({ kind: "upsert_competitors", rows });
        for (const row of rows) domains.add(row.domain);
        return;
      }

      if ("removeCompetitors" in update) {
        const removed = update.removeCompetitors.map(normalizeCompetitorDomain);
        resolved.push({ kind: "delete_competitors", domains: removed });
        for (const domain of removed) domains.delete(domain);
        return;
      }

      if ("addKeyPages" in update) {
        const rows = dedupeBy(
          update.addKeyPages.map((page) => ({
            url: normalizeKeyPageUrl(page.url),
            role: page.role ?? null,
            topic: page.topic ?? null,
            notes: page.notes ?? null,
          })),
          (row) => row.url,
        );
        const additions = rows.filter((row) => !urls.has(row.url)).length;
        if (urls.size + additions > MAX_KEY_PAGES) {
          throw new AppError(
            400,
            "context_cap",
            "A workspace can hold 100 key pages. This is a shortlist, not a page inventory.",
          );
        }
        resolved.push({ kind: "upsert_key_pages", rows });
        for (const row of rows) urls.add(row.url);
        return;
      }

      if ("removeKeyPages" in update) {
        const removed = update.removeKeyPages.map(normalizeKeyPageUrl);
        resolved.push({ kind: "delete_key_pages", urls: removed });
        for (const url of removed) urls.delete(url);
        return;
      }

      if ("removeResearchLog" in update) {
        resolved.push({ kind: "delete_research_log", ids: update.removeResearchLog });
        return;
      }

      const entry = update.appendResearchLog;
      resolved.push({
        kind: "append_research_log",
        summary: entry.summary.trim(),
        research_kind: entry.kind ?? "note",
        research_key: entry.researchKey === undefined ? null : normalizeResearchKey(entry.researchKey),
        spend_usd: null,
        job_id: null,
      });
    } catch (error) {
      throw rejectedUpdate(index, error);
    }
  });

  return resolved;
}
