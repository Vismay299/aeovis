// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/reports/shared.tsx:45-54
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// F23 §6.6 — who a report row says wrote it. The wire `createdBy` is the
// self-reported half ("assistant" or "app"); `createdByYou` resolves the
// assistant half to the reader ("you" or "a teammate") without naming anyone.
export type WrittenByInput = {
  createdBy: string;
  createdByYou: boolean;
};

export function formatWrittenBy(report: WrittenByInput): string {
  if (report.createdBy === "assistant") {
    return report.createdByYou ? "Assistant · you" : "Assistant · a teammate";
  }
  return "Perceev app";
}
