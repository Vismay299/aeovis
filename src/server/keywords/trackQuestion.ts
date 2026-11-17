// F13 track-as-question service: bridge keywords into the AI-visibility question library.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addWorkspaceQuestion,
  type WorkspaceQuestion,
} from "../questions/workspaceQuestions.ts";

export type TrackKeywordAsQuestionInput = {
  brandKey: string;
  userId: string | null;
  keyword: string;
  text: string;
  topic?: string;
  locationCode: number;
  languageCode: string;
};

export type TrackKeywordAsQuestionDeps = {
  add?: typeof addWorkspaceQuestion;
};

export type TrackKeywordAsQuestionResult = {
  question: WorkspaceQuestion;
  created: boolean;
  revived: boolean;
};

export async function trackKeywordAsQuestion(
  admin: SupabaseClient,
  input: TrackKeywordAsQuestionInput,
  deps?: TrackKeywordAsQuestionDeps,
): Promise<TrackKeywordAsQuestionResult> {
  const add = deps?.add ?? addWorkspaceQuestion;
  return add(admin, {
    brandKey: input.brandKey,
    text: input.text,
    origin: "manual",
    createdBy: input.userId,
    topic: input.topic,
    sourceRef: {
      kind: "keyword",
      keyword: input.keyword,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
    },
  });
}
