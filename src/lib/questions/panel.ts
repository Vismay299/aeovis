// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/ai-prompt-suggestions.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";
import { repairWorkflowStore } from "../db/repairWorkflow.js";
import { validatePanel } from "../repairs/workflow.js";
import { getBrandAliases } from "../scoring/aliases.js";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import {
  type QuestionOrigin,
  type QuestionSettings,
  type WorkspaceQuestion,
  listWorkspaceQuestions,
  normalizeQuestionText,
  readQuestionSettings,
  saveQuestionPatch,
} from "./workspaceQuestions.ts";

export const PANEL_ORIGIN_BY_QUESTION_ORIGIN: Record<QuestionOrigin, string> = {
  ai_setup: "generated",
  ai_generate: "generated",
  promptgen: "generated",
  prompt_research: "search_questions",
  manual: "manual",
  import: "manual",
};

const VALID_PANEL_ORIGINS = new Set([
  "generated",
  "gsc_search",
  "customer_research",
  "licensed_panel",
  "manual",
  "search_questions",
]);

export type PanelPromptInput = {
  id: string;
  question_id: string;
  text: string;
  topic: string;
  origin: string;
  workspace_origin: QuestionOrigin;
  cohort: "core";
  weight: 1;
  purpose?: "diagnostic";
  duplicate_reason?: string;
};

export type PanelInput = {
  persona: string | null;
  context: {
    country: string;
    language: string;
    device: "desktop";
    session_policy: "fresh_anonymous";
  };
  source: "workspace_questions";
  workspace_revision: number;
  prompts: PanelPromptInput[];
};

export type PanelArtifact = {
  id?: string;
  brand?: string;
  kind?: string;
  artifact_key?: string;
  version: number;
  state?: string;
  created_at?: string;
  payload?: {
    persona?: string | null;
    context?: { country?: string; language?: string; [k: string]: unknown };
    prompts?: Array<{
      id?: string;
      question_id?: string;
      text: string;
      topic?: string;
      purpose?: string;
      branded?: boolean;
      duplicate_reason?: string;
      [k: string]: unknown;
    }>;
    summary?: Record<string, number>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

function resolvePanelOrigin(q: WorkspaceQuestion): string {
  if (
    q.origin === "import" &&
    q.sourceRef &&
    typeof q.sourceRef.panel_origin === "string" &&
    VALID_PANEL_ORIGINS.has(q.sourceRef.panel_origin)
  ) {
    return q.sourceRef.panel_origin;
  }
  return PANEL_ORIGIN_BY_QUESTION_ORIGIN[q.origin] ?? "manual";
}

function compareQuestionsForPanel(a: WorkspaceQuestion, b: WorkspaceQuestion): number {
  const isAGeneral = a.topic.trim().toLowerCase() === "general";
  const isBGeneral = b.topic.trim().toLowerCase() === "general";
  if (isAGeneral && !isBGeneral) return 1;
  if (!isAGeneral && isBGeneral) return -1;
  const topicComp = a.topic.localeCompare(b.topic);
  if (topicComp !== 0) return topicComp;
  const createdComp = a.createdAt.localeCompare(b.createdAt);
  if (createdComp !== 0) return createdComp;
  return a.id.localeCompare(b.id);
}

export function buildPanelInput(
  settings: QuestionSettings,
  active: WorkspaceQuestion[],
  revision: number
): PanelInput {
  const activeOnly = active
    .filter((q) => q.status === "active")
    .slice()
    .sort(compareQuestionsForPanel);

  const prompts: PanelPromptInput[] = activeOnly.map((q) => {
    const prompt: PanelPromptInput = {
      id: q.id,
      question_id: q.id,
      text: q.text,
      topic: q.topic,
      origin: resolvePanelOrigin(q),
      workspace_origin: q.origin,
      cohort: "core",
      weight: 1,
    };
    if (q.branded) {
      prompt.purpose = "diagnostic";
    }
    if (q.duplicateReason) {
      prompt.duplicate_reason = q.duplicateReason;
    }
    return prompt;
  });

  return {
    persona: settings.persona || null,
    context: {
      country: settings.country || "in",
      language: settings.language || "en",
      device: "desktop",
      session_policy: "fresh_anonymous",
    },
    source: "workspace_questions",
    workspace_revision: revision,
    prompts,
  };
}

export function diffAgainstApproved(
  approved: PanelArtifact | null,
  active: WorkspaceQuestion[],
  settings: QuestionSettings
): {
  approvedVersion: number | null;
  added: number;
  removed: number;
  contextChanged: boolean;
  dirty: boolean;
} {
  const activeQuestions = active.filter((q) => q.status === "active");
  if (!approved) {
    return {
      approvedVersion: null,
      added: activeQuestions.length,
      removed: 0,
      contextChanged: false,
      dirty: activeQuestions.length > 0 || Boolean(settings.persona),
    };
  }

  const approvedPrompts = approved.payload?.prompts || [];
  const approvedTexts = new Set(
    approvedPrompts.map((p) => normalizeQuestionText(p.text))
  );
  const activeTexts = new Set(
    activeQuestions.map((q) => q.textNormalized)
  );

  let added = 0;
  for (const text of activeTexts) {
    if (!approvedTexts.has(text)) added++;
  }

  let removed = 0;
  for (const text of approvedTexts) {
    if (!activeTexts.has(text)) removed++;
  }

  const approvedPersona = (approved.payload?.persona ?? "").trim();
  const currentPersona = (settings.persona ?? "").trim();
  const approvedCountry = (approved.payload?.context?.country ?? "in").toLowerCase();
  const currentCountry = (settings.country ?? "in").toLowerCase();
  const approvedLanguage = (approved.payload?.context?.language ?? "en").toLowerCase();
  const currentLanguage = (settings.language ?? "en").toLowerCase();

  const contextChanged =
    approvedPersona !== currentPersona ||
    approvedCountry !== currentCountry ||
    approvedLanguage !== currentLanguage;

  const dirty = added > 0 || removed > 0 || contextChanged;

  return {
    approvedVersion: approved.version ?? null,
    added,
    removed,
    contextChanged,
    dirty,
  };
}

export function nearDuplicatePairs(
  active: WorkspaceQuestion[],
  aliases: string[]
): { leftId: string; rightId: string; similarity: number }[] {
  const activeOnly = active.filter((q) => q.status === "active");
  if (activeOnly.length < 2) return [];

  const dummySettings: QuestionSettings = {
    brandKey: "dummy",
    revision: 0,
    persona: "Shoppers",
    country: "in",
    language: "en",
    researchKeywords: [],
    setupJobId: null,
    setupSavedJobId: null,
    setupSavedAt: null,
    backfilledAt: null,
  };

  const input = buildPanelInput(dummySettings, activeOnly, 0);
  try {
    const validated = (validatePanel as any)(input, { brandAliases: aliases });
    if (!Array.isArray(validated?.near_duplicates)) return [];
    return validated.near_duplicates.map((pair: { left: string; right: string; similarity: number }) => ({
      leftId: pair.left,
      rightId: pair.right,
      similarity: pair.similarity,
    }));
  } catch {
    return [];
  }
}

export type ApproveQuestionPanelDeps = {
  repairWorkflowStore?: typeof repairWorkflowStore;
  now?: () => string;
};

export async function approveQuestionPanel(
  admin: SupabaseClient,
  ws: Workspace,
  expectedRevision: number,
  deps?: ApproveQuestionPanelDeps
): Promise<{
  version: number;
  approvedAt: string;
  questionCount: number;
  diagnosticCount: number;
  summary: Record<string, number>;
}> {
  // (1) settings revision ≠ expectedRevision → revision_conflict
  const settings = await readQuestionSettings(admin, ws.brandKey);
  if (settings.revision !== expectedRevision) {
    throw new AppError(
      409,
      "revision_conflict",
      "These questions changed since you opened them. Reload to see the latest."
    );
  }

  // (2) read active questions and settings
  const questions = await listWorkspaceQuestions(admin, ws.brandKey, {
    statuses: ["active"],
  });

  // (3) persona empty → AppError(400,"persona_required","Describe who asks these questions before approving.")
  const persona = (settings.persona ?? "").trim();
  if (!persona) {
    throw new AppError(
      400,
      "persona_required",
      "Describe who asks these questions before approving."
    );
  }

  // (4) no active non-branded → AppError(409,"nothing_to_approve","Add at least one question that does not name your brand.")
  const hasNonBranded = questions.some((q) => !q.branded);
  if (!hasNonBranded) {
    throw new AppError(
      409,
      "nothing_to_approve",
      "Add at least one question that does not name your brand."
    );
  }

  // (5) validatePanel(input, { brandAliases }) (throws → AppError(400,"panel_invalid", err.message))
  const aliases =
    ws.brand.aliases?.length
      ? ws.brand.aliases
      : getBrandAliases(ws.brand.display_name, ws.brand.website);

  const panelInput = buildPanelInput(settings, questions, settings.revision);
  let validated: any;
  try {
    validated = (validatePanel as any)(panelInput, { brandAliases: aliases });
  } catch (err: any) {
    throw new AppError(400, "panel_invalid", err.message, { cause: err });
  }

  // (6) unexplained near_duplicates → AppError(409,"near_duplicates","Some questions look alike. Archive one of each pair or say why both are needed.", { details: { pairs } })
  if (Array.isArray(validated?.near_duplicates) && validated.near_duplicates.length > 0) {
    const pairs = validated.near_duplicates.map((pair: { left: string; right: string; similarity: number }) => ({
      leftId: pair.left,
      rightId: pair.right,
      similarity: pair.similarity,
    }));
    throw new AppError(
      409,
      "near_duplicates",
      "Some questions look alike. Archive one of each pair or say why both are needed.",
      { details: { pairs } }
    );
  }

  // (7) re-read the revision; changed → revision_conflict
  const freshSettings = await readQuestionSettings(admin, ws.brandKey);
  if (freshSettings.revision !== expectedRevision) {
    throw new AppError(
      409,
      "revision_conflict",
      "These questions changed since you opened them. Reload to see the latest."
    );
  }

  // (8) repairWorkflowStore(admin).append({ brand, kind: "panel", key: "default", expectedVersion: head?.version ?? 0, state: "approved", payload: { ...validated, reviewer: user.id, reviewed_at: now, reason: null }, actor: user.id })
  const store = (deps?.repairWorkflowStore ?? repairWorkflowStore)(admin);
  const headList: any = await store.list(ws.brandKey, "panel");
  const defaultHead: any = (headList || []).find((h: any) => h?.artifact_key === "default");
  const headVersion = Number(defaultHead?.version ?? 0);
  const approvedAt = deps?.now ? deps.now() : new Date().toISOString();

  const payload = {
    ...validated,
    reviewer: ws.user.id,
    reviewed_at: approvedAt,
    reason: null,
  };

  try {
    await (store as any).append({
      brand: ws.brandKey,
      kind: "panel",
      key: "default",
      expectedVersion: headVersion,
      state: "approved",
      payload,
      actor: ws.user.id,
    });
  } catch (err: any) {
    const message = typeof err?.message === "string" ? err.message : "";
    if (message.includes("artifact revision conflict")) {
      throw new AppError(
        409,
        "panel_conflict",
        "The question panel changed. Reload and approve again.",
        { cause: err }
      );
    }
    throw err;
  }

  // (9) one approved event per included question via save_workspace_questions with no rows (bumps revision)
  const events = questions.map((q) => ({
    question_id: q.id,
    event: "approved" as const,
    detail: { panel_version: headVersion + 1 },
  }));

  await saveQuestionPatch(admin, {
    brandKey: ws.brandKey,
    expectedRevision: freshSettings.revision,
    rows: [],
    events,
    actor: ws.user.id,
  });

  return {
    version: headVersion + 1,
    approvedAt,
    questionCount: questions.length,
    diagnosticCount: questions.filter((q) => q.branded).length,
    summary: validated.summary ?? {},
  };
}
