// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/ai-prompt-suggestions.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";
import { matchesBrandAlias } from "../repairs/workflow.js";
import { getBrandAliases } from "../scoring/aliases.js";
import type { QuestionEvent, ResolvedQuestionRow } from "./applyQuestionPatch.ts";

export const QUESTION_ORIGINS = [
  "ai_setup",
  "ai_generate",
  "prompt_research",
  "promptgen",
  "manual",
  "import",
] as const;
export type QuestionOrigin = (typeof QUESTION_ORIGINS)[number];
export type QuestionStatus = "active" | "paused" | "archived";
export const MAX_UNARCHIVED_QUESTIONS = 100,
  MAX_TOPICS = 30,
  DEFAULT_TOPIC = "General";

export type WorkspaceQuestion = {
  id: string;
  brandKey: string;
  text: string;
  textNormalized: string;
  topic: string;
  origin: QuestionOrigin;
  status: QuestionStatus;
  branded: boolean;
  cohort: "core";
  replacedBy: string | null;
  duplicateReason: string | null;
  sourceRef: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type QuestionSettings = {
  brandKey: string;
  revision: number;
  persona: string | null;
  country: string;
  language: string;
  researchKeywords: string[];
  setupJobId: string | null;
  setupSavedJobId: string | null;
  setupSavedAt: string | null;
  backfilledAt: string | null;
};

export type SettingsPatch = {
  persona?: string | null;
  country?: string;
  language?: string;
  research_keywords?: string[];
  setup_saved_job_id?: string | null;
};

type QuestionRpcResult = {
  id?: string;
  status?: QuestionStatus;
  created?: boolean;
  revived?: boolean;
  revision?: number | string;
};

export function canonicalQuestionText(raw: string): string {
  return String(raw).normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function normalizeQuestionText(raw: string): string {
  return canonicalQuestionText(raw).toLowerCase();
}

export function isBrandedQuestion(text: string, aliases: string[]): boolean {
  return matchesBrandAlias(text, aliases);
}

function mapQuestionError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const value = error as { code?: string; message?: string } | null;
  const message = typeof value?.message === "string" ? value.message : "";
  if (message.includes("question_cap:questions"))
    return new AppError(
      409,
      "question_limit",
      "You can track up to 100 questions. Archive unused questions first.",
      { cause: error },
    );
  if (message.includes("question_cap:topics"))
    return new AppError(
      409,
      "topic_limit",
      "You can use up to 30 topics. Archive the questions of an unused topic first.",
      { cause: error },
    );
  if (message.includes("question_revision_conflict"))
    return new AppError(
      409,
      "revision_conflict",
      "These questions changed since you opened them. Reload to see the latest.",
      { cause: error },
    );
  if (value?.code === "23505")
    return new AppError(
      409,
      "question_duplicate",
      "Another question already has this wording.",
      { cause: error },
    );
  if (message.includes("question_text_immutable"))
    return new AppError(500, "internal_error", "Something went wrong. Please retry.", {
      cause: error,
    });
  return new AppError(
    503,
    "questions_unavailable",
    "Questions could not be saved. Please retry.",
    { cause: error },
  );
}

function asQuestion(row: Record<string, unknown>): WorkspaceQuestion {
  return {
    id: String(row.id),
    brandKey: String(row.brand_key),
    text: String(row.text),
    textNormalized: String(row.text_normalized),
    topic: String(row.topic),
    origin: row.origin as QuestionOrigin,
    status: row.status as QuestionStatus,
    branded: Boolean(row.branded),
    cohort: "core",
    replacedBy: row.replaced_by == null ? null : String(row.replaced_by),
    duplicateReason:
      row.duplicate_reason == null ? null : String(row.duplicate_reason),
    sourceRef:
      row.source_ref && typeof row.source_ref === "object"
        ? (row.source_ref as Record<string, unknown>)
        : null,
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
  };
}

function assertQuestionInput(i: {
  text: string;
  origin: string;
  status?: string;
}): string {
  const text = canonicalQuestionText(i.text);
  if (text.length < 2 || text.length > 1500)
    throw new AppError(400, "question_invalid", "Question text must be 2 to 1,500 characters.");
  if (!QUESTION_ORIGINS.includes(i.origin as QuestionOrigin))
    throw new AppError(400, "question_invalid", "Question origin is not supported.");
  if (i.status !== undefined && !["active", "paused", "archived"].includes(i.status))
    throw new AppError(400, "question_invalid", "Question status is not supported.");
  return text;
}

export async function addWorkspaceQuestion(
  admin: SupabaseClient,
  i: {
    brandKey: string;
    text: string;
    origin: QuestionOrigin;
    createdBy: string | null;
    status?: QuestionStatus;
    topic?: string;
    sourceRef?: Record<string, unknown>;
  },
): Promise<{ question: WorkspaceQuestion; created: boolean; revived: boolean }> {
  const text = assertQuestionInput(i);
  try {
    const { data: brand, error: brandError } = await admin
      .from("customer_brands")
      .select("display_name,website")
      .eq("brand_key", i.brandKey)
      .maybeSingle();
    if (brandError || !brand) throw brandError || new Error("Workspace is unavailable");
    const aliases = getBrandAliases(brand.display_name, brand.website);
    const { data, error } = await admin.rpc("add_workspace_question", {
      p_brand: i.brandKey,
      p_text: text,
      p_topic: i.topic ?? DEFAULT_TOPIC,
      p_origin: i.origin,
      p_status: i.status ?? "active",
      p_branded: isBrandedQuestion(text, aliases),
      p_source_ref: i.sourceRef ?? null,
      p_actor: i.createdBy,
    });
    if (error) throw error;
    const result = data as QuestionRpcResult;
    if (!result?.id) throw new Error("Question insert returned no id");
    const { data: row, error: readError } = await admin
      .from("workspace_questions")
      .select("*")
      .eq("brand_key", i.brandKey)
      .eq("id", result.id)
      .single();
    if (readError || !row) throw readError || new Error("Question read failed");
    return {
      question: asQuestion(row),
      created: result.created === true,
      revived: result.revived === true,
    };
  } catch (error) {
    throw mapQuestionError(error);
  }
}

export async function listWorkspaceQuestions(
  admin: SupabaseClient,
  brandKey: string,
  o?: { statuses?: QuestionStatus[] },
): Promise<WorkspaceQuestion[]> {
  try {
    let query = admin
      .from("workspace_questions")
      .select("*")
      .eq("brand_key", brandKey)
      .order("topic")
      .order("created_at")
      .order("id");
    if (o?.statuses?.length) query = query.in("status", o.statuses);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map((row) => asQuestion(row));
  } catch (error) {
    throw mapQuestionError(error);
  }
}

export async function readQuestionSettings(
  admin: SupabaseClient,
  brandKey: string,
): Promise<QuestionSettings> {
  try {
    const { data, error } = await admin
      .from("workspace_question_settings")
      .select("*")
      .eq("brand_key", brandKey)
      .maybeSingle();
    if (error) throw error;
    return {
      brandKey,
      revision: Number(data?.revision ?? 0),
      persona: data?.persona ?? null,
      country: data?.country ?? "in",
      language: data?.language ?? "en",
      researchKeywords: data?.research_keywords ?? [],
      setupJobId: data?.setup_job_id ?? null,
      setupSavedJobId: data?.setup_saved_job_id ?? null,
      setupSavedAt: data?.setup_saved_at ?? null,
      backfilledAt: data?.backfilled_at ?? null,
    };
  } catch (error) {
    throw mapQuestionError(error);
  }
}

export async function saveQuestionPatch(
  admin: SupabaseClient,
  i: {
    brandKey: string;
    expectedRevision: number;
    rows: ResolvedQuestionRow[];
    events: QuestionEvent[];
    settings?: Partial<SettingsPatch>;
    actor: string | null;
  },
): Promise<{ revision: number }> {
  try {
    const { data, error } = await admin.rpc("save_workspace_questions", {
      p_brand: i.brandKey,
      p_expected_revision: i.expectedRevision,
      p_rows: i.rows,
      p_events: i.events,
      p_settings: i.settings ?? null,
      p_actor: i.actor,
    });
    if (error) throw error;
    return { revision: Number((data as { revision?: number } | null)?.revision ?? 0) };
  } catch (error) {
    throw mapQuestionError(error);
  }
}

export async function saveQuestionSettings(
  admin: SupabaseClient,
  i: {
    brandKey: string;
    settings: Partial<SettingsPatch>;
    actor: string | null;
  },
): Promise<{ revision: number }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const settings = await readQuestionSettings(admin, i.brandKey);
    try {
      return await saveQuestionPatch(admin, {
        brandKey: i.brandKey,
        expectedRevision: settings.revision,
        rows: [],
        events: [],
        settings: i.settings,
        actor: i.actor,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "revision_conflict" || attempt === 1)
        throw error;
    }
  }
  throw new AppError(503, "questions_unavailable", "Questions could not be saved. Please retry.");
}

export async function syncPanelQuestions(
  admin: SupabaseClient,
  i: {
    brandKey: string;
    prompts: { text: string; topic?: string; purpose?: string; origin?: string }[];
    settings: { persona?: string; country?: string; language?: string };
    actor: string | null;
  },
): Promise<{ revision: number; ids: { text: string; question_id: string }[] }> {
  try {
    const { data, error } = await admin.rpc("sync_panel_questions", {
      p_brand: i.brandKey,
      p_prompts: i.prompts,
      p_settings: i.settings,
      p_actor: i.actor,
    });
    if (error) throw error;
    const result = data as { revision?: number; ids?: { text: string; question_id: string }[] } | null;
    return { revision: Number(result?.revision ?? 0), ids: result?.ids ?? [] };
  } catch (error) {
    throw mapQuestionError(error);
  }
}

export async function ensureBackfilled(
  admin: SupabaseClient,
  brandKey: string,
): Promise<void> {
  try {
    const { error } = await admin.rpc("backfill_workspace_questions", {
      p_brand: brandKey,
    });
    if (error) throw error;
  } catch (error) {
    throw mapQuestionError(error);
  }
}
