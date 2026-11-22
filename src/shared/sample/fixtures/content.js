/** Content Studio: three drafts at different stages, the starter agents and the crew. */
import { starterAgentsForWorkspace } from "../../content/agents/model.js";
import { FORMATS } from "../../content/agents/formats.js";
import { CREW } from "../../content/agents/crew.js";
import { BLOCKS, DEFAULT_PIPELINES } from "../../content/agents/blocks.js";
import { BRAND, BRAND_KEY, daysAgo } from "./brand.js";

const DRAFTS = [
  {
    id: "c9000000-0000-4000-8000-000000000001", title: "NABH quality indicators: the full list, and how to report each one", status: "awaiting_approval", playbook: "guide",
    agent_name: "Guide writer", agent_format: "guide", created_at: daysAgo(6, 15), updated_at: daysAgo(1, 9),
    body_md: `# NABH quality indicators: the full list, and how to report each one\n\nNABH's 5th edition asks every accredited hospital to track a defined set of quality indicators and report them monthly. This guide lists them by chapter, gives the formula and data source for each, and shows how a hospital can automate the return.\n\n## Why the indicators matter\n\nAssessors look for trends, not one-off numbers. Hospitals that can show twelve months of clean indicator data move through assessment faster.\n\n## Readmission rate (worked example)\n\n**Formula:** readmissions within 30 days ÷ discharges in the period × 100.\n\n**Data source:** the HIMS discharge register, matched on UHID.\n\nA 220-bed hospital with 1,140 discharges and 46 readmissions in a month reports **4.0%**.\n\n## Automating the monthly return\n\n${BRAND} reads the indicators from your existing HIMS and produces the NABH return each month, with the audit trail assessors ask for.\n`,
    rubric: { verdict: "pass", weighted_total: 0.86, below_threshold: false, ymyl_violation: false, violations: [], check: { passed: true, content_hash: "sample-hash-1", issues: [] } },
    content_version: 3, content_hash: "sample-hash-1",
  },
  {
    id: "c9000000-0000-4000-8000-000000000002", title: "Readmission benchmarks for Indian hospitals (2026)", status: "approved", playbook: "article",
    agent_name: "Article writer", agent_format: "article", created_at: daysAgo(20, 11), updated_at: daysAgo(14, 16),
    body_md: `# Readmission benchmarks for Indian hospitals (2026)\n\nWhat a "good" 30-day readmission rate looks like depends on case mix. This article sets out ranges by specialty and hospital size.\n`,
    rubric: { verdict: "pass", weighted_total: 0.91, below_threshold: false, ymyl_violation: false, violations: [], check: { passed: true, content_hash: "sample-hash-2", issues: [] } },
    content_version: 5, content_hash: "sample-hash-2",
  },
  {
    id: "c9000000-0000-4000-8000-000000000003", title: "Which hospital sizes Brightwave fits", status: "draft", playbook: "landing",
    agent_name: "Page writer", agent_format: "landing", created_at: daysAgo(2, 12), updated_at: daysAgo(2, 12),
    body_md: `# Built for 100–400 bed hospitals\n\n${BRAND} is designed for mid-size private hospitals that have outgrown spreadsheet reporting.\n`,
    rubric: { verdict: "revise", weighted_total: 0.64, below_threshold: true, ymyl_violation: false, violations: [{ rule: "evidence", detail: "Add a source for the bed-count range." }], check: { passed: false, content_hash: "sample-hash-3", issues: [{ detail: "The claim about hospital sizes needs a supporting source." }] } },
    content_version: 1, content_hash: "sample-hash-3",
  },
];

const listRow = ({ body_md, rubric, content_version, content_hash, ...row }) => row;

export const list = () => ({ items: DRAFTS.map(listRow), jobs: [] });
export const item = (id) => {
  const d = DRAFTS.find((x) => x.id === id);
  return d ? { item: { ...d, brand: BRAND_KEY, agent_snapshot: { name: d.agent_name, format: d.agent_format } } } : undefined;
};

export function agents() {
  return { agents: [], templates: starterAgentsForWorkspace(BRAND_KEY, []), formats: Object.values(FORMATS), blocks: Object.values(BLOCKS), crew: CREW, default_pipelines: DEFAULT_PIPELINES };
}
