// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/lighthousePayload.ts
//   src/server/lib/lighthouseStoredPayload.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";

export type LighthouseCategory = "performance" | "accessibility" | "best-practices" | "seo";

export const storedLighthousePayloadSchema = z.object({
  version: z.literal(2),
  source: z.literal("dataforseo-lighthouse"),
  hasIssueDetails: z.boolean(),
  metadata: z.object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    strategy: z.enum(["mobile", "desktop"]),
    fetchedAt: z.string(),
    lighthouseVersion: z.string().nullable(),
    taskId: z.string().nullable(),
    cost: z.number().nullable(),
  }),
  scores: z.object({
    performance: z.number().nullable(),
    accessibility: z.number().nullable(),
    "best-practices": z.number().nullable(),
    seo: z.number().nullable(),
  }),
  metrics: z.record(z.string(), z.any()),
  issues: z.array(z.any()),
});

export type StoredLighthousePayload = z.infer<typeof storedLighthousePayloadSchema>;

export function readStoredLighthousePayload(payloadJson: string, categoryFilter?: LighthouseCategory) {
  let storedPayload: StoredLighthousePayload | null = null;
  try {
    const parsed = storedLighthousePayloadSchema.safeParse(JSON.parse(payloadJson));
    if (parsed.success) storedPayload = parsed.data;
  } catch {
    try { JSON.parse(payloadJson); } catch { throw new Error("Invalid Lighthouse payload JSON"); }
  }
  const issues = categoryFilter
    ? (storedPayload?.issues ?? []).filter((i: any) => i?.category === categoryFilter)
    : (storedPayload?.issues ?? []);
  return {
    storedPayload,
    report: {
      hasIssueDetails: storedPayload?.hasIssueDetails ?? false,
      issues,
    },
  };
}

export function buildLighthouseExportFile(input: {
  idField: "auditId" | "resultId";
  idValue: string;
  finalUrl: string;
  strategy: "mobile" | "desktop";
  createdAt: string;
  payloadJson: string;
  mode: "full" | "issues" | "category";
  category?: LighthouseCategory;
}) {
  const safeDate = input.createdAt.replace(/[:.]/g, "-");
  const baseName = `lighthouse-${input.strategy}-${safeDate}`;
  if (input.mode === "full") {
    return { filename: `${baseName}-payload.json`, content: input.payloadJson };
  }
  const { report } = readStoredLighthousePayload(input.payloadJson, input.category);
  return {
    filename:
      input.mode === "category" && input.category
        ? `${baseName}-${input.category}-issues.json`
        : `${baseName}-issues.json`,
    content: JSON.stringify(
      {
        [input.idField]: input.idValue,
        finalUrl: input.finalUrl,
        strategy: input.strategy,
        createdAt: input.createdAt,
        category: input.category ?? "all",
        issues: report.issues,
      },
      null,
      2,
    ),
  };
}