// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/websiteTrackingSetup.ts:11-74
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// Candidate assembly for setup review (F08 §6.2.7)

import {
  canonicalQuestionText,
  normalizeQuestionText,
  isBrandedQuestion,
  MAX_TOPICS,
  MAX_UNARCHIVED_QUESTIONS,
} from "../workspaceQuestions.ts";
import { isEliciting } from "../../scoring/promptQuality.js";
import { CONTROL_PROMPTS } from "../../scoring/controlPrompts.js";
import { mergeKey } from "../promptResearch.ts";
import type { SetupCandidate } from "./schemas.ts";

export type AssembleCandidatesInput = {
  researchTopics: Array<{ name: string; questions: string[] }>;
  promptgenItems: Array<{ text: string; topic: string; source: string }>;
  existingQuestions: Array<{
    id: string;
    text: string;
    textNormalized: string;
    status: "active" | "paused" | "archived";
  }>;
  aliases: string[];
  unarchivedRoom?: number;
};

type IntermediateCandidate = {
  text: string;
  norm: string;
  mKey: string;
  topic: string;
  origin: "ai_setup" | "promptgen";
  isResearchFirstThree: boolean;
};

export function assembleCandidates(input: AssembleCandidatesInput): SetupCandidate[] {
  const controlSet = new Set(
    CONTROL_PROMPTS.map((c) => normalizeQuestionText(c.text)),
  );

  const existingMap = new Map<
    string,
    { questionId: string; status: "active" | "paused" | "archived" }
  >();
  let existingUnarchivedCount = 0;
  for (const eq of input.existingQuestions) {
    existingMap.set(eq.textNormalized, { questionId: eq.id, status: eq.status });
    if (eq.status !== "archived") {
      existingUnarchivedCount += 1;
    }
  }

  const room =
    input.unarchivedRoom !== undefined
      ? input.unarchivedRoom
      : Math.max(0, MAX_UNARCHIVED_QUESTIONS - existingUnarchivedCount);

  // Research topic lookup for promptGen folding
  const researchTopicNormMap = new Map<string, string>();
  for (const t of input.researchTopics) {
    const key = t.name.trim().toLowerCase();
    if (!researchTopicNormMap.has(key)) {
      researchTopicNormMap.set(key, t.name.trim());
    }
  }

  const rawList: IntermediateCandidate[] = [];

  // 1. Research topics (up to 5 topics x 5 questions)
  for (let topicIdx = 0; topicIdx < input.researchTopics.length; topicIdx += 1) {
    const topic = input.researchTopics[topicIdx];
    const isFirstThree = topicIdx < 3;
    for (const rawText of topic.questions) {
      const canonical = canonicalQuestionText(rawText);
      const norm = normalizeQuestionText(canonical);
      rawList.push({
        text: canonical,
        norm,
        mKey: mergeKey(canonical),
        topic: topic.name.trim() || "General",
        origin: "ai_setup",
        isResearchFirstThree: isFirstThree,
      });
    }
  }

  // 2. Promptgen items
  for (const p of input.promptgenItems) {
    const canonical = canonicalQuestionText(p.text);
    const norm = normalizeQuestionText(canonical);
    const itemTopicNorm = (p.topic || "").trim().toLowerCase();
    const resolvedTopic = researchTopicNormMap.get(itemTopicNorm) || p.topic.trim() || "General";

    rawList.push({
      text: canonical,
      norm,
      mKey: mergeKey(canonical),
      topic: resolvedTopic,
      origin: "promptgen",
      isResearchFirstThree: false,
    });
  }

  // Deduplicate and filter
  const seenNorm = new Set<string>();
  const seenMerge = new Set<string>();
  const deduped: IntermediateCandidate[] = [];

  for (const item of rawList) {
    if (item.text.length < 2) continue;
    // Drop control prompts
    if (controlSet.has(item.norm)) continue;
    // Drop duplicates by normalized text
    if (seenNorm.has(item.norm)) continue;
    // Drop near-duplicates by mergeKey
    if (seenMerge.has(item.mKey)) continue;

    seenNorm.add(item.norm);
    seenMerge.add(item.mKey);
    deduped.push(item);
  }

  // Cap distinct topics at 30 by folding extras into "General"
  const distinctTopics: string[] = [];
  const topicMap = new Map<string, string>(); // lower -> actual name

  for (const item of deduped) {
    const normTopic = item.topic.trim().toLowerCase();
    if (!topicMap.has(normTopic)) {
      if (distinctTopics.length < MAX_TOPICS) {
        distinctTopics.push(item.topic);
        topicMap.set(normTopic, item.topic);
      } else {
        topicMap.set(normTopic, "General");
      }
    }
    item.topic = topicMap.get(normTopic) || "General";
  }

  // Build candidate objects with IDs and selection logic
  let selectedCount = 0;
  const maxToSelect = Math.min(30, room);

  const candidates: SetupCandidate[] = [];

  for (let i = 0; i < deduped.length; i += 1) {
    const item = deduped[i];
    const candidateId = `c${i + 1}`;
    const branded = isBrandedQuestion(item.text, input.aliases);
    const eliciting = isEliciting(item.text);
    const existing = existingMap.get(item.norm) || null;

    let shouldSelect = false;

    // Existing active/paused questions are never selected (already tracked)
    if (existing && existing.status !== "archived") {
      shouldSelect = false;
    } else {
      if (selectedCount < maxToSelect) {
        if (item.origin === "ai_setup" && item.isResearchFirstThree) {
          shouldSelect = true;
          selectedCount += 1;
        } else if (item.origin === "promptgen" && eliciting) {
          shouldSelect = true;
          selectedCount += 1;
        }
      }
    }

    candidates.push({
      id: candidateId,
      text: item.text,
      topic: item.topic,
      origin: item.origin,
      branded,
      eliciting,
      selected: shouldSelect,
      existing,
    });
  }

  return candidates;
}
