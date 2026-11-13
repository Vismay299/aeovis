// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/lighthouse/issues/utils.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { CategoryTab, LighthouseIssue } from "./types.ts";

export function categoryLabel(category: CategoryTab): string {
  if (category === "best-practices") return "Best practices";
  if (category === "all") return "All";
  return `${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}

const ISSUE_HEADERS = [
  "Category",
  "Severity",
  "Score",
  "Title",
  "Display Value",
  "Description",
  "Impact (ms)",
  "Impact (bytes)",
  "Affected Items",
];

export function issuesToTable(issues: LighthouseIssue[]) {
  return {
    headers: ISSUE_HEADERS,
    rows: issues.map((issue) => [
      issue.category,
      issue.severity,
      issue.score ?? "",
      issue.title,
      issue.displayValue ?? "",
      issue.description ?? "",
      issue.impactMs ?? "",
      issue.impactBytes ?? "",
      issue.items.length,
    ]),
  };
}
