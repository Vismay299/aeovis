// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/dataforseo-research-tools.ts, src/server/mcp/tools/local-seo-tools.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { pickRowFields, readPath } from "./shared.ts";

export const LOCAL_BUSINESS_ROW_FIELDS = [
  "title",
  "description",
  "category",
  "additional_categories",
  "address",
  "phone",
  "url",
  "domain",
  "rating",
  "is_claimed",
  "cid",
  "place_id",
  "latitude",
  "longitude",
  "total_photos",
  "check_url",
] as const;

export const LOCAL_SERP_ROW_FIELDS = [
  "rank_group",
  "rank_absolute",
  "title",
  "domain",
  "url",
  "contact_url",
  "address",
  "address_info",
  "phone",
  "category",
  "additional_categories",
  "rating",
  "rating_distribution",
  "price_level",
  "is_claimed",
  "cid",
  "place_id",
  "latitude",
  "longitude",
  "total_photos",
  "work_hours",
  "local_justifications",
] as const;

export const BUSINESS_QUESTION_ROW_FIELDS = [
  "rank_absolute",
  "question_id",
  "question_text",
  "original_question_text",
  "profile_name",
  "time_ago",
  "timestamp",
] as const;

export const BUSINESS_ANSWER_ROW_FIELDS = [
  "answer_id",
  "answer_text",
  "original_answer_text",
  "profile_name",
  "time_ago",
  "timestamp",
] as const;

export const REVIEW_ROW_FIELDS = [
  "rank_absolute",
  "time_ago",
  "timestamp",
  "rating",
  "review_text",
  "original_review_text",
  "original_language",
  "profile_name",
  "local_guide",
  "reviews_count",
  "photos_count",
  "review_highlights",
  "source",
  "owner_answer",
  "owner_time_ago",
  "owner_timestamp",
  "review_id",
] as const;

export const BUSINESS_UPDATE_ROW_FIELDS = [
  "rank_absolute",
  "author",
  "post_date",
  "timestamp",
  "post_text",
  "snippet",
  "url",
  "links",
] as const;

export function trimBusinessQuestionRow(row: unknown): Record<string, unknown> {
  const trimmed = pickRowFields(row, BUSINESS_QUESTION_ROW_FIELDS);
  const answers = readPath(row, "items");
  trimmed.items = Array.isArray(answers)
    ? answers.map((answer) => pickRowFields(answer, BUSINESS_ANSWER_ROW_FIELDS))
    : null;
  return trimmed;
}

function answerTimestamp(answer: unknown): string {
  const at = readPath(answer, "timestamp");
  return typeof at === "string" ? at : "";
}

function readString(source: unknown, ...path: string[]): string | undefined {
  const value = readPath(source, ...path);
  return typeof value === "string" ? value : undefined;
}

export function latestAnswerText(row: unknown): unknown {
  const items = readPath(row, "items");
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const answers: unknown[] = items;
  const sorted = [...answers].sort((a, b) =>
    answerTimestamp(b).localeCompare(answerTimestamp(a)),
  );
  const latest = sorted[0];
  return (
    readPath(latest, "answer_text") ?? readPath(latest, "original_answer_text")
  );
}

export function formatPostLinks(links: unknown): string {
  if (!Array.isArray(links) || links.length === 0) return "—";
  const rendered = links.map((link) => {
    const url = readString(link, "url");
    const title = readString(link, "title") ?? readString(link, "type");
    if (url == null) return title ?? "";
    return title == null ? url : `${title} → ${url}`;
  });
  return rendered.filter((entry) => entry !== "").join("; ") || "—";
}
