// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiResearchKeywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { repairWorkflowStore } from "../db/repairWorkflow.js";
import { getJobStatus } from "../jobs/status.ts";
import { getBrandAliases } from "../scoring/aliases.js";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import {
  diffAgainstApproved,
  nearDuplicatePairs,
  type PanelArtifact,
} from "./panel.ts";
import {
  MAX_TOPICS,
  MAX_UNARCHIVED_QUESTIONS,
  type QuestionOrigin,
  type QuestionSettings,
  type QuestionStatus,
  type WorkspaceQuestion,
  ensureBackfilled,
  listWorkspaceQuestions,
  readQuestionSettings,
} from "./workspaceQuestions.ts";

export type QuestionsState = {
  brandKey: string;
  revision: number;
  settings: {
    persona: string | null;
    country: string;
    language: string;
    researchKeywords: string[];
  };
  questions: Array<{
    id: string;
    text: string;
    topic: string;
    origin: QuestionOrigin;
    status: QuestionStatus;
    branded: boolean;
    cohort: "core";
    replacedBy: string | null;
    duplicateReason: string | null;
    createdAt: string;
    archivedAt: string | null;
  }>;
  topics: Array<{
    name: string;
    active: number;
    paused: number;
  }>;
  approved: {
    version: number;
    approvedAt: string;
    questionCount: number;
    diagnosticCount: number;
    carriesQuestionIds: boolean;
  } | null;
  diff: {
    approvedVersion: number | null;
    added: number;
    removed: number;
    contextChanged: boolean;
    dirty: boolean;
  };
  nearDuplicates: Array<{
    leftId: string;
    rightId: string;
    similarity: number;
  }>;
  limits: {
    unarchived: number;
    maxUnarchived: number;
    topics: number;
    maxTopics: number;
  };
  setup: {
    status: "none" | "running" | "review" | "failed" | "saved";
    jobId: string | null;
    failure: "website_unreadable" | "budget_reached" | "other" | null;
  };
};

export type StateDeps = {
  ensureBackfilled?: typeof ensureBackfilled;
  repairWorkflowStore?: typeof repairWorkflowStore;
  getJobStatus?: typeof getJobStatus;
};

export async function getQuestionsState(
  admin: SupabaseClient,
  ws: Workspace,
  deps?: StateDeps
): Promise<QuestionsState> {
  const backfill = deps?.ensureBackfilled ?? ensureBackfilled;
  await backfill(admin, ws.brandKey);

  const questions = await listWorkspaceQuestions(admin, ws.brandKey);
  const settings = await readQuestionSettings(admin, ws.brandKey);

  const store = (deps?.repairWorkflowStore ?? repairWorkflowStore)(admin);
  const headList: any = await store.list(ws.brandKey, "panel");
  const defaultHead: any = (headList || []).find((h: any) => h?.artifact_key === "default");

  let approvedArtifact: PanelArtifact | null =
    defaultHead && defaultHead.state === "approved" ? (defaultHead as PanelArtifact) : null;

  if (!approvedArtifact) {
    const { data: latestApproved } = await admin
      .from("repair_artifacts")
      .select("*")
      .eq("brand", ws.brandKey)
      .eq("kind", "panel")
      .eq("artifact_key", "default")
      .eq("state", "approved")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    approvedArtifact = (latestApproved as PanelArtifact) || null;
  }

  // Topics calculation from unarchived questions
  const unarchived = questions.filter((q) => q.status !== "archived");
  const topicMap = new Map<string, { name: string; active: number; paused: number }>();
  for (const q of unarchived) {
    const key = q.topic.trim().toLowerCase();
    let entry = topicMap.get(key);
    if (!entry) {
      entry = { name: q.topic, active: 0, paused: 0 };
      topicMap.set(key, entry);
    }
    if (q.status === "active") entry.active++;
    else if (q.status === "paused") entry.paused++;
  }

  const topics = Array.from(topicMap.values()).sort((a, b) => {
    const isAGen = a.name.trim().toLowerCase() === "general";
    const isBGen = b.name.trim().toLowerCase() === "general";
    if (isAGen && !isBGen) return 1;
    if (!isAGen && isBGen) return -1;
    return a.name.localeCompare(b.name);
  });

  // Approved summary
  let approvedSummary: QuestionsState["approved"] = null;
  if (approvedArtifact) {
    const prompts = approvedArtifact.payload?.prompts || [];
    approvedSummary = {
      version: approvedArtifact.version,
      approvedAt: ((approvedArtifact.payload?.reviewed_at as string) || approvedArtifact.created_at || "") as string,
      questionCount: prompts.length,
      diagnosticCount: prompts.filter((p: any) => p.purpose === "diagnostic" || p.branded).length,
      carriesQuestionIds: prompts.length > 0 && prompts.every((p: any) => Boolean(p.question_id)),
    };
  }

  // Diff
  const diff = diffAgainstApproved(approvedArtifact, questions, settings);

  // Near duplicate pairs
  const aliases =
    ws.brand.aliases?.length
      ? ws.brand.aliases
      : getBrandAliases(ws.brand.display_name, ws.brand.website);
  const nearDuplicates = nearDuplicatePairs(questions, aliases);

  // Limits
  const distinctTopicCount = topicMap.size;
  const limits = {
    unarchived: unarchived.length,
    maxUnarchived: MAX_UNARCHIVED_QUESTIONS,
    topics: distinctTopicCount,
    maxTopics: MAX_TOPICS,
  };

  // Setup status
  let setupStatus: "none" | "running" | "review" | "failed" | "saved" = "none";
  let failure: "website_unreadable" | "budget_reached" | "other" | null = null;
  const jobId = settings.setupJobId;

  if (jobId) {
    if (settings.setupSavedJobId && settings.setupSavedJobId === jobId) {
      setupStatus = "saved";
    } else {
      try {
        const fetchJobStatus = deps?.getJobStatus ?? getJobStatus;
        const job = await fetchJobStatus(jobId);
        if (job.status === "completed") {
          setupStatus = "review";
        } else if (job.status === "failed" || job.status === "cancelled") {
          setupStatus = "failed";
          const code = job.error?.code;
          if (code === "website_unreadable") failure = "website_unreadable";
          else if (code === "budget_reached") failure = "budget_reached";
          else failure = "other";
        } else {
          setupStatus = "running";
        }
      } catch {
        setupStatus = "none";
      }
    }
  }

  return {
    brandKey: ws.brandKey,
    revision: settings.revision,
    settings: {
      persona: settings.persona,
      country: settings.country,
      language: settings.language,
      researchKeywords: settings.researchKeywords,
    },
    questions: questions.map((q) => ({
      id: q.id,
      text: q.text,
      topic: q.topic,
      origin: q.origin,
      status: q.status,
      branded: q.branded,
      cohort: "core",
      replacedBy: q.replacedBy,
      duplicateReason: q.duplicateReason,
      createdAt: q.createdAt,
      archivedAt: q.archivedAt,
    })),
    topics,
    approved: approvedSummary,
    diff,
    nearDuplicates,
    limits,
    setup: {
      status: setupStatus,
      jobId,
      failure,
    },
  };
}
