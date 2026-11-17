// F17 research-log keys and summaries (F07 project memory). One entry per paid
// purchase, kind = the spend feature. Keys are stable per lookup so a quote can
// find "this ran in the last 90 days" (F17-AC-12).

import type { SupabaseClient } from "@supabase/supabase-js";
import { appendResearch as defaultAppendResearch, findRecentResearch as defaultFindRecentResearch } from "../projectContext/service.ts";
import type { SpendFeature } from "../../shared/spend-features.ts";

export const RECENT_RESEARCH_DAYS = 90;

export type LocalResearchKind = Extract<SpendFeature, "local.business" | "local.reviews" | "local.serp" | "local.grid">;

export type ResearchDeps = {
  appendResearch?: typeof defaultAppendResearch;
  findRecentResearch?: typeof defaultFindRecentResearch;
};

type Rating = number | null | undefined;

function stars(value: Rating): string {
  return value == null ? "no rating" : `${value}★`;
}

function count(value: number | null | undefined): string {
  return value == null ? "an unknown number of" : String(value);
}

export function profileResearchKey(identifier: { cid?: string | null; placeId?: string | null; name?: string | null }): string {
  return `profile|${identifier.cid || identifier.placeId || identifier.name || ""}`;
}

export function profileResearchSummary(input: {
  title?: string | null;
  category?: string | null;
  rating?: Rating;
  votes?: number | null;
  identifier?: string;
}): string {
  if (!input.title) return `No Google Business Profile matched ${input.identifier ?? "the lookup"}.`;
  return `Google Business Profile for ${input.title}: ${input.category ?? "no category"}, ${stars(input.rating)} from ${count(input.votes)} reviews.`;
}

export function fetchResearchKey(input: { kind: string; cid?: string | null; placeId?: string | null; depth: number }): string {
  return `${input.kind}|${input.cid || input.placeId || ""}|${input.depth}`;
}

export function fetchResearchFeature(kind: "reviews" | "extended_reviews" | "updates" | "questions"): LocalResearchKind {
  return kind === "reviews" || kind === "extended_reviews" ? "local.reviews" : "local.business";
}

export function fetchResearchSummary(input: {
  kind: "reviews" | "extended_reviews" | "updates" | "questions";
  title: string | null;
  collected: number;
  total?: number | null;
}): string {
  const title = input.title ?? "the business";
  if (input.kind === "updates") return `Posts on ${title}'s profile: ${input.collected} collected.`;
  if (input.kind === "questions") return `Questions on ${title}'s profile: ${input.collected} collected.`;
  return `Reviews for ${title}: collected ${input.collected} of ${input.total ?? input.collected}.`;
}

export function gridResearchKey(input: { keyword: string; latitude: number; longitude: number; gridSize: number; spacingKm: number }): string {
  return `${input.keyword}|${input.latitude}|${input.longitude}|${input.gridSize}|${input.spacingKm}`;
}

export function gridResearchSummary(input: {
  keyword: string;
  gridSize: number;
  spacingKm: number;
  found: number;
  searched: number;
  averageRank: number | null;
}): string {
  const average = input.averageRank == null ? "no average rank" : `average ${input.averageRank}`;
  return `Map ranking grid for “${input.keyword}” (${input.gridSize}×${input.gridSize}, ${input.spacingKm} km): ranked at ${input.found} of ${input.searched} points, ${average}.`;
}

export function serpResearchKey(input: {
  keyword: string;
  latitude: number;
  longitude: number;
  zoom: number;
  searchType: string;
}): string {
  return `serp|${input.keyword}|${input.latitude}|${input.longitude}|${input.zoom}|${input.searchType}`;
}

export function serpResearchSummary(input: {
  keyword: string;
  latitude: number;
  longitude: number;
  count: number;
  ownRank: number | null;
}): string {
  const rank = input.ownRank == null ? "not in the results" : String(input.ownRank);
  return `Local results for “${input.keyword}” near ${input.latitude},${input.longitude}: ${input.count} businesses; you rank ${rank}.`;
}

/** Writes one research-log entry. Never throws: the purchase has already happened. */
export async function appendLocalResearch(
  ws: { admin: SupabaseClient; brandKey: string; user: { id: string } },
  entry: { kind: LocalResearchKind; researchKey: string; summary: string; spendUsd?: number | null },
  deps?: ResearchDeps,
): Promise<boolean> {
  try {
    await (deps?.appendResearch ?? defaultAppendResearch)(ws.admin, {
      brandKey: ws.brandKey,
      kind: entry.kind,
      researchKey: entry.researchKey,
      summary: entry.summary,
      spendUsd: entry.spendUsd ?? null,
      author: "user",
      actorUserId: ws.user.id,
    });
    return true;
  } catch (err) {
    console.error("[local] research log failed", err instanceof Error ? err.name : typeof err);
    return false;
  }
}

/** The `recent_research` quote warning, or null when the lookup has not run in 90 days. */
export async function recentResearchWarning(
  admin: SupabaseClient,
  input: { brandKey: string; kind: LocalResearchKind; researchKey: string },
  deps?: ResearchDeps,
): Promise<{ code: "recent_research"; message: string } | null> {
  try {
    const recent = await (deps?.findRecentResearch ?? defaultFindRecentResearch)(admin, {
      brandKey: input.brandKey,
      kind: input.kind,
      researchKey: input.researchKey,
      days: RECENT_RESEARCH_DAYS,
    });
    if (!recent) return null;
    return { code: "recent_research", message: `You looked this up on ${recent.entryDate}: ${recent.summary}` };
  } catch {
    return null;
  }
}
