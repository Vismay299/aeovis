/** Reports: two generated reports and one saved template. The document itself is served by /r/[id]. */
import { BRAND, daysAgo } from "./brand.js";

export const SAMPLE_REPORT_IDS = Object.freeze({ audit: "f2000000-0000-4000-8000-000000000001", monthly: "f2000000-0000-4000-8000-000000000002" });
const TEMPLATE_ID = "f3000000-0000-4000-8000-000000000001";

function meta(kind) {
  const audit = kind === "audit";
  return {
    id: SAMPLE_REPORT_IDS[kind], title: audit ? `${BRAND} AI Visibility Audit` : `${BRAND} monthly check-in`,
    createdAt: daysAgo(audit ? 1 : 9, 10), updatedAt: daysAgo(audit ? 1 : 9, 10), createdBy: audit ? "assistant" : "app", createdByYou: audit,
    htmlBytes: audit ? 18240 : 14310, shared: !audit, skill: audit ? "ai-visibility-audit" : null, skillTitle: audit ? "AI Visibility Audit" : null,
    templateId: audit ? null : TEMPLATE_ID, templateName: audit ? null : "Monthly leadership update",
  };
}

export const list = () => ({ reports: [meta("audit"), meta("monthly")] });

export function detail(id) {
  const kind = Object.entries(SAMPLE_REPORT_IDS).find(([, v]) => v === id)?.[0];
  if (!kind) return undefined;
  return { report: { ...meta(kind), chatPath: kind === "audit" ? "/portal/assistant?s=f1000000-0000-4000-8000-000000000001" : null, shareToken: null, sharedAt: kind === "audit" ? null : daysAgo(9, 11), views30d: kind === "audit" ? null : 6 } };
}

export const templates = () => ({
  remaining: 9,
  templates: [{ id: TEMPLATE_ID, name: "Monthly leadership update", description: "The one-page update for Brightwave's leadership team.", instructions: "Audience: CEO and head of marketing.\nSections: Where we are / What changed / What we do next.\nTone: plain, no jargon.\nAccent: #f5f5f5", createdAt: daysAgo(30), updatedAt: daysAgo(30) }],
});
