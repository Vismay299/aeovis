// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/projects/services/ProjectWebsiteService.ts:56-97,
//   src/server/features/ai-visibility/services/websiteTrackingSetup.ts:11-55
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../http/appError.ts";
import type { Workspace } from "../../workspace/requireWorkspace.ts";
import { jobStore, type JobStore } from "../../jobs/store.ts";
import { createProjectContextRepository } from "../../projectContext/repository.ts";
import type { ResolvedOp } from "../../projectContext/contextUpdateOps.ts";
import type { ProjectCompetitorSource } from "../../../shared/project-context.ts";
import {
  canonicalQuestionText,
  listWorkspaceQuestions,
  readQuestionSettings,
  saveQuestionPatch,
} from "../workspaceQuestions.ts";
import { projectQuestionPatch } from "../applyQuestionPatch.ts";
import { approveQuestionPanel } from "../panel.ts";
import { getQuestionsState, type QuestionsState } from "../state.ts";
import { getBrandAliases } from "../../scoring/aliases.js";
import { normalizeCompetitorDomain } from "./research.ts";
import { SUPPORTED_COUNTRIES } from "../questions.contract.ts";
import type { SetupReview, SetupCandidate } from "./schemas.ts";

export const saveSetupBodySchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  jobId: z.string().uuid(),
  expectedRevision: z.number().int().min(0),
  overview: z.string().trim().min(1).max(4000).optional(),
  competitors: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(120),
        domain: z.string().trim().min(1).max(255),
        notes: z.string().trim().max(500).default(""),
      }),
    )
    .max(100),
  selectedCandidateIds: z.array(z.string().regex(/^c\d{1,3}$/)).max(100),
  persona: z.string().trim().min(1).max(500),
  country: z.enum(SUPPORTED_COUNTRIES),
  language: z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/),
  approve: z.boolean(),
});

export type SaveSetupBody = z.infer<typeof saveSetupBodySchema>;

export type SaveSetupDeps = {
  store?: JobStore;
  repo?: ReturnType<typeof createProjectContextRepository>;
  approveQuestionPanel?: typeof approveQuestionPanel;
  getQuestionsState?: typeof getQuestionsState;
};

export async function saveSetupReview(
  admin: SupabaseClient,
  ws: Workspace,
  body: SaveSetupBody,
  deps?: SaveSetupDeps,
): Promise<{
  saved: {
    questionsAdded: number;
    revived: number;
    competitorsSaved: number;
    overviewSaved: boolean;
  };
  panel: {
    version: number;
    approvedAt: string;
    questionCount: number;
    diagnosticCount: number;
    summary: Record<string, number>;
  } | null;
  state: QuestionsState;
  approveError?: { code: string; message: string };
}> {
  // 1. Validate Job
  const store: any = deps?.store ?? jobStore();
  const job = await (typeof store.getJob === "function" ? store.getJob(body.jobId) : store.get(body.jobId));
  if (!job || job.brand_key !== ws.brandKey || job.kind !== "questions.setup") {
    throw new AppError(404, "setup_not_found", "Setup research was not found.");
  }
  if (job.status !== "completed") {
    throw new AppError(
      409,
      "setup_not_ready",
      "Setup research is still running. Please wait for it to complete.",
    );
  }

  const settings = await readQuestionSettings(admin, ws.brandKey);
  if (settings.setupSavedJobId === body.jobId) {
    throw new AppError(409, "setup_already_saved", "This setup was already saved.");
  }

  const review = (job.result as { review?: SetupReview })?.review;
  if (!review) {
    throw new AppError(404, "setup_not_found", "Setup research review is missing.");
  }

  // 2. F07 Context Ops
  const contextOps: ResolvedOp[] = [];
  let overviewSaved = false;
  let competitorsSaved = 0;

  if (!review.overview.preserved && body.overview) {
    contextOps.push({
      kind: "insert_section_if_missing",
      key: "business_overview",
      title: null,
      content: body.overview,
    });
    overviewSaved = true;
  }

  const ownHostNorm = normalizeCompetitorDomain(ws.brand.website_host || ws.brand.website);

  if (!review.competitors.preserved && body.competitors.length > 0) {
    const compRows: Array<{
      domain: string;
      name: string | null;
      notes: string | null;
      source: ProjectCompetitorSource;
      source_url: string | null;
    }> = [];

    for (const comp of body.competitors) {
      const compDomainNorm = normalizeCompetitorDomain(comp.domain);
      if (!compDomainNorm) continue;
      if (compDomainNorm === ownHostNorm) {
        throw new AppError(400, "context_invalid", "Your own website cannot be a competitor.");
      }
      const matchingReviewComp = (review.competitors.items || []).find(
        (item) => normalizeCompetitorDomain(item.domain) === compDomainNorm,
      );
      const source: ProjectCompetitorSource = matchingReviewComp ? "setup_research" : "manual";
      const source_url = matchingReviewComp?.sourceUrl ?? null;
      compRows.push({
        domain: compDomainNorm,
        name: comp.name.trim() || null,
        notes: comp.notes.trim() || null,
        source,
        source_url,
      });
    }

    if (compRows.length > 0) {
      contextOps.push({
        kind: "insert_competitors_if_none",
        rows: compRows,
      });
      competitorsSaved = compRows.length;
    }
  }

  if (contextOps.length > 0) {
    const repo = deps?.repo ?? createProjectContextRepository(admin);
    await repo.applyOps(ws.brandKey, contextOps, "user", ws.user.id);
  }

  // 3. Questions patch
  const candidateMap = new Map<string, SetupCandidate>(
    review.candidates.map((c) => [c.id, c]),
  );
  const selectedCandidates: SetupCandidate[] = [];
  for (const id of body.selectedCandidateIds) {
    const c = candidateMap.get(id);
    if (c) selectedCandidates.push(c);
  }

  const currentQuestions = await listWorkspaceQuestions(admin, ws.brandKey, {
    statuses: ["active", "paused", "archived"],
  });

  const aliases =
    ws.brand.aliases && ws.brand.aliases.length > 0
      ? ws.brand.aliases
      : getBrandAliases(ws.brand.display_name, ws.brand.website);

  const candidateByText = new Map<string, SetupCandidate>();
  for (const c of selectedCandidates) {
    candidateByText.set(canonicalQuestionText(c.text), c);
  }

  const { rows, events, created } = projectQuestionPatch(
    currentQuestions,
    {
      questions: selectedCandidates.map((c) => ({
        text: c.text,
        topic: c.topic,
      })),
    },
    {
      origin: "ai_setup",
      aliases,
      sourceRef: { kind: "setup", jobId: body.jobId },
    },
  );

  // Set candidate origin per row
  for (const row of rows) {
    if (row.op === "insert") {
      const match = candidateByText.get(row.text);
      if (match?.origin === "promptgen") {
        row.origin = "promptgen";
      } else {
        row.origin = "ai_setup";
      }
    }
  }

  const revived = events.filter((e) => e.event === "revived").length;

  const researchKeywords = Array.from(
    new Set([...(review.topics || []), ...(review.suggestedKeywords || [])]),
  ).slice(0, 45);

  const { revision: newRevision } = await saveQuestionPatch(admin, {
    brandKey: ws.brandKey,
    expectedRevision: body.expectedRevision,
    rows,
    events,
    settings: {
      persona: body.persona,
      country: body.country,
      language: body.language,
      research_keywords: researchKeywords,
      setup_saved_job_id: body.jobId,
    },
    actor: ws.user.id,
  });

  // 4. Panel Approval if requested
  let panel: {
    version: number;
    approvedAt: string;
    questionCount: number;
    diagnosticCount: number;
    summary: Record<string, number>;
  } | null = null;
  let approveError: { code: string; message: string } | undefined;

  if (body.approve) {
    const approveFn = deps?.approveQuestionPanel ?? approveQuestionPanel;
    try {
      panel = await approveFn(admin, ws, newRevision);
    } catch (err: any) {
      if (err instanceof AppError) {
        approveError = { code: err.code, message: err.message };
      } else {
        approveError = {
          code: "panel_invalid",
          message: err?.message || "Could not approve question panel.",
        };
      }
    }
  }

  // 5. Build and return state
  const stateFn = deps?.getQuestionsState ?? getQuestionsState;
  const state = await stateFn(admin, ws);

  return {
    saved: {
      questionsAdded: created,
      revived,
      competitorsSaved,
      overviewSaved,
    },
    panel,
    state,
    ...(approveError ? { approveError } : {}),
  };
}
