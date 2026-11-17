import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";
import { addWorkspaceQuestion } from "../../server/questions/workspaceQuestions.ts";
import type { RankAiQuestion } from "../rank-tracking.ts";

export type TrackKeywordAsAiQuestionDeps = {
  admin?: SupabaseClient;
  add?: typeof addWorkspaceQuestion;
  repo?: any;
};

export async function trackKeywordAsAiQuestion(
  ws: { brandKey: string; userId?: string | null },
  configId: string,
  keywordId: string,
  i: { text: string; topic?: string },
  deps?: TrackKeywordAsAiQuestionDeps,
): Promise<{ questionId: string; created: boolean; revived: boolean; linked: boolean }> {
  const admin = deps?.admin;
  if (!admin) {
    throw new AppError(503, "storage_unavailable", "Database service unavailable");
  }

  // 1. Verify keyword exists on tracker
  const { data: keywordRow, error: kwError } = await admin
    .from("rank_tracking_keywords")
    .select("id, keyword, config_id")
    .eq("brand_key", ws.brandKey)
    .eq("config_id", configId)
    .eq("id", keywordId)
    .maybeSingle();

  if (kwError) {
    throw new AppError(503, "rank_tracking_unavailable", kwError.message);
  }
  if (!keywordRow) {
    throw new AppError(404, "keyword_not_found", "This tracked keyword does not exist.");
  }

  // 2. Fetch config for locationCode & languageCode
  const { data: configRow, error: cfgError } = await admin
    .from("rank_tracking_configs")
    .select("location_code, language_code")
    .eq("brand_key", ws.brandKey)
    .eq("id", configId)
    .maybeSingle();

  if (cfgError) {
    throw new AppError(503, "rank_tracking_unavailable", cfgError.message);
  }
  if (!configRow) {
    throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  }

  // 3. Call addWorkspaceQuestion (F08 injected add)
  const addFn = deps?.add ?? addWorkspaceQuestion;
  const result = await addFn(admin, {
    brandKey: ws.brandKey,
    text: i.text,
    origin: "manual",
    createdBy: ws.userId ?? null,
    topic: i.topic,
    sourceRef: {
      kind: "rank_keyword",
      trackingKeywordId: keywordId,
      keyword: keywordRow.keyword,
      locationCode: configRow.location_code,
      languageCode: configRow.language_code,
    },
  });

  const questionId = result.question.id;

  // 4. Link keyword to question in rank_keyword_questions (idempotent ON CONFLICT DO NOTHING)
  const { error: linkError } = await admin
    .from("rank_keyword_questions")
    .upsert(
      {
        brand_key: ws.brandKey,
        tracking_keyword_id: keywordId,
        question_id: questionId,
        created_by: ws.userId ?? null,
      },
      { onConflict: "tracking_keyword_id,question_id", ignoreDuplicates: true },
    );

  if (linkError) {
    throw new AppError(503, "rank_tracking_unavailable", linkError.message);
  }

  return {
    questionId,
    created: result.created,
    revived: result.revived,
    linked: true,
  };
}

export function mapAioStatus(
  row: {
    state: string;
    aio_present: boolean | null;
    own_cited: boolean | null;
    own_mentioned: boolean | null;
  } | null,
): RankAiQuestion["status"] {
  if (!row) return "not_measured";
  if (row.state === "answered") {
    if (row.own_cited) return "cited";
    if (row.own_mentioned) return "mentioned";
    return "absent";
  }
  if (row.state === "valid_no_aio") {
    return "no_overview";
  }
  return "not_measured";
}

// 42P01: F12's question_answer_links missing inside the function. PGRST205 /
// PGRST202: PostgREST cannot see migration 112's table / function yet (not
// applied). Every case degrades to "not measured" rather than failing the page.
const UNAVAILABLE_CODES = new Set(["42P01", "PGRST205", "PGRST202"]);
function isUnavailable(err: any): boolean {
  return UNAVAILABLE_CODES.has(err?.code) || Boolean(err?.message?.includes("42P01"));
}

export async function aiStatusesForKeywords(
  admin: SupabaseClient | any,
  brandKey: string,
  keywordIds: string[],
): Promise<Map<string, RankAiQuestion>> {
  const result = new Map<string, RankAiQuestion>();
  if (!admin || !keywordIds.length) return result;

  try {
    // 1. Fetch links for these keywords
    const { data: links, error: linkErr } = await admin
      .from("rank_keyword_questions")
      .select("tracking_keyword_id, question_id, created_at")
      .eq("brand_key", brandKey)
      .in("tracking_keyword_id", keywordIds)
      .order("created_at", { ascending: false });

    if (linkErr) {
      if (isUnavailable(linkErr)) {
        console.warn("[rank-tracking] aio status unavailable");
        return result;
      }
      throw linkErr;
    }

    if (!links || links.length === 0) return result;

    // Keep the newest question_id per tracking_keyword_id
    const keywordToQuestion = new Map<string, string>();
    const questionIdsSet = new Set<string>();
    for (const link of links) {
      if (!keywordToQuestion.has(link.tracking_keyword_id)) {
        keywordToQuestion.set(link.tracking_keyword_id, link.question_id);
        questionIdsSet.add(link.question_id);
      }
    }

    const questionIds = Array.from(questionIdsSet);
    if (!questionIds.length) return result;

    // 2. Query status via rpc rank_question_aio_status
    const { data: aioRows, error: rpcErr } = await admin.rpc(
      "rank_question_aio_status",
      {
        p_brand: brandKey,
        p_question_ids: questionIds,
      },
    );

    if (rpcErr) {
      if (isUnavailable(rpcErr)) {
        console.warn("[rank-tracking] aio status unavailable");
        for (const [kwId, qId] of keywordToQuestion.entries()) {
          result.set(kwId, {
            questionId: qId,
            status: "not_measured",
            measuredAt: null,
          });
        }
        return result;
      }
      throw rpcErr;
    }

    const questionStatusMap = new Map<string, { status: RankAiQuestion["status"]; measuredAt: string | null }>();
    for (const row of aioRows || []) {
      questionStatusMap.set(row.question_id, {
        status: mapAioStatus(row),
        measuredAt: row.collected_at ?? null,
      });
    }

    for (const [kwId, qId] of keywordToQuestion.entries()) {
      const qStatus = questionStatusMap.get(qId);
      result.set(kwId, {
        questionId: qId,
        status: qStatus ? qStatus.status : "not_measured",
        measuredAt: qStatus ? qStatus.measuredAt : null,
      });
    }

    return result;
  } catch (error: any) {
    if (isUnavailable(error)) {
      console.warn("[rank-tracking] aio status unavailable");
      return result;
    }
    throw error;
  }
}
