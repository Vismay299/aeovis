// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/settings/IndexNowSettings.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const KEY_FILE_STATUSES = [
  "found",
  "missing",
  "wrong_content",
  "redirects",
  "moved",
  "unreachable",
  "unknown",
] as const;

export type KeyFileStatus = (typeof KEY_FILE_STATUSES)[number];

export const KEY_FILE_LABELS: Record<KeyFileStatus, string> = {
  found: "Found",
  missing: "Not found",
  wrong_content: "Should contain only the key",
  redirects: "Redirects. The file must load at this address itself",
  moved: "Redirects to another address",
  unreachable: "Couldn't reach this address",
  unknown: "Couldn't check right now",
};

export function isUnusedHost(status: KeyFileStatus): boolean {
  return status === "moved" || status === "unreachable";
}

export function isProblemStatus(status: KeyFileStatus): boolean {
  return status === "missing" || status === "wrong_content" || status === "redirects";
}

export function keyFileReady(hosts: Array<{ host: string; status: KeyFileStatus }>): boolean {
  const used = hosts.filter((h) => !isUnusedHost(h.status));
  return used.length > 0 && used.every((h) => h.status === "found");
}

export function splitUrls(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function pluralUrls(n: number): string {
  return `${n} URL${n === 1 ? "" : "s"}`;
}

export const SUBMISSION_SOURCES = ["settings", "audit", "content", "tool"] as const;
export type SubmissionSource = (typeof SUBMISSION_SOURCES)[number];

export const SUBMISSION_SOURCE_LABELS = {
  settings: "Settings",
  audit: "Site audit",
  content: "Content Studio",
  tool: "Assistant",
} as const;

export const MAX_URLS_PER_SUBMISSION = 10_000;

export const ENGINE_LABELS = {
  bing: "Bing",
  yandex: "Yandex",
  yep: "Yep",
} as const;
