import { renderStepPrompt } from "../skills/loader.js";
import { validateLessons } from "../schemas.js";
import {
  listLessons,
  insertLessons,
  deactivateLessonByText,
} from "../../../server/db/content.js";
import { callStepLlm } from "./shared.js";

/**
 * Learn step: distill a human feedback comment into 0–3 imperative lessons,
 * dedupe against existing (the LLM sees them and is told not to duplicate),
 * insert into content_lessons, and deactivate superseded lessons.
 *
 * Fired from the decision route on feedback with a comment. Fire-and-forget:
 * a learn failure must never break the approval flow.
 */
export async function runLearn({ brand, playbook, verdict, comment, item }, deps = {}) {
  if (!comment || !comment.trim()) return { lessons: [] };

  const db = {
    listLessons: deps.listLessons || listLessons,
    insertLessons: deps.insertLessons || insertLessons,
    deactivateLessonByText: deps.deactivateLessonByText || deactivateLessonByText,
  };

  const existing = await db.listLessons(brand, playbook, { activeOnly: true });

  const itemSummary = [
    `Playbook: ${playbook}`,
    `Title: ${item?.title || "(untitled)"}`,
    `Rubric verdict: ${item?.rubric?.verdict || "n/a"} (weighted ${item?.rubric?.weighted_total ?? "n/a"})`,
    `Draft opening: ${(item?.body_md || "").slice(0, 300)}`,
  ].join("\n");

  const prompt = renderStepPrompt("learn", "shared", {
    brand,
    playbook,
    verdict,
    comment,
    item_summary: itemSummary,
    existing_lessons:
      existing.length > 0
        ? existing.map((l) => `- ${l.lesson}`).join("\n")
        : "(none yet)",
  });

  const result = await callStepLlm({
    step: "learn",
    prompt,
    validate: validateLessons,
    llm: deps.llm,
    stats: deps.stats,
    temperature: 0.2,
  });

  // Supersede first, then insert — so a replacement never dedupes against
  // the lesson it is replacing.
  for (const l of result.lessons) {
    if (l.supersedes) {
      await db.deactivateLessonByText(brand, playbook, l.supersedes);
    }
  }

  const inserted = await db.insertLessons(
    brand,
    playbook,
    result.lessons.map((l) => l.lesson),
    deps.sourceFeedbackId
  );

  return { lessons: result.lessons, inserted };
}
