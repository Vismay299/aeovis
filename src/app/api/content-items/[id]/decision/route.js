import { NextResponse } from "next/server";
import {
  getContentItem,
  updateContentItem,
  insertContentFeedback,
  updateContentJob,
} from "@/lib/db/content";
import { insertContentEvent } from "@/lib/db";
import { reviseContentItem } from "@/lib/content/contentWorker";
import { runLearn } from "@/lib/content/steps/learn";
import { decideItemStatus, jobStatusForItemStatus } from "@/lib/content/stages";

export const dynamic = "force-dynamic";

const VERDICTS = ["approved", "changes_requested", "rejected"];

/** Slug for the synthetic content URL — built from the primary target query
 * so contentLift's isPromptRelatedToUrl matches it against scan prompts. */
function contentEventUrl(item) {
  const primary = (item.target_queries || [])[0] || item.title || item.id;
  const slug = String(primary)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
  return `https://studio.perceev.app/content/${slug || item.id}`;
}

/**
 * POST /api/content-items/[id]/decision — { verdict, comment }.
 * The human gate: status change + feedback row + learn step (async) +
 * on approve (geo_article) a content_events row for lift tracking +
 * on changes_requested an async revision pass.
 */
export async function POST(request, { params }) {
  try {
    const { id } = params;
    const payload = await request.json();
    const verdict = (payload.verdict || "").trim();
    const comment = (payload.comment || "").trim();

    if (!VERDICTS.includes(verdict)) {
      return NextResponse.json(
        { detail: `verdict must be one of: ${VERDICTS.join(", ")}` },
        { status: 400 }
      );
    }
    if ((verdict === "changes_requested" || verdict === "rejected") && !comment) {
      return NextResponse.json(
        { detail: `A comment is required when verdict is "${verdict}".` },
        { status: 400 }
      );
    }

    const item = await getContentItem(id);
    if (!item) {
      return NextResponse.json({ detail: "Item not found." }, { status: 404 });
    }

    // Route the decision through the stage machine (T2) instead of re-deriving
    // the rules here: it owns "which statuses are review gates" and "where does
    // each verdict go", so the gate and the target status can never disagree.
    const routed = decideItemStatus(item.status, verdict);
    if (!routed.ok) {
      return NextResponse.json(
        { detail: routed.error },
        { status: routed.code === "bad_verdict" ? 400 : 409 }
      );
    }
    const newStatus = routed.status;

    // 1. Feedback row — the raw learning signal.
    const feedback = await insertContentFeedback({
      item_id: id,
      brand: item.brand,
      verdict,
      comment,
    });

    // 2. Status change. changes_requested keeps the item in-flight; the
    //    revision pass returns it to awaiting_approval when done.
    await updateContentItem(id, { status: newStatus });
    if (item.job_id) {
      try {
        await updateContentJob(item.job_id, { status: jobStatusForItemStatus(newStatus) });
      } catch (err) {
        console.warn("[decision] job status sync failed:", err.message);
      }
    }

    // 3. Approved geo_article → content_events row keyed to target queries,
    //    so the existing contentLift computation picks it up on the next scan.
    if (verdict === "approved" && item.playbook === "geo_article") {
      try {
        await insertContentEvent({
          brand: item.brand,
          url: contentEventUrl(item),
        });
      } catch (err) {
        console.warn("[decision] content_events insert failed:", err.message);
      }
    }

    // 4. Learn step — fire-and-forget; a learn failure never blocks the gate.
    if (comment) {
      runLearn(
        {
          brand: item.brand,
          playbook: item.playbook,
          verdict,
          comment,
          item,
        },
        { sourceFeedbackId: feedback?.id }
      ).catch((err) => console.warn("[decision] learn step failed:", err.message));
    }

    // 5. Changes requested → async revision pass with the human comment as
    //    the critique. Fire-and-forget; Studio polls the item list.
    if (verdict === "changes_requested") {
      reviseContentItem(id, comment).catch((err) =>
        console.error(`[decision] revision of item ${id} failed:`, err)
      );
    }

    return NextResponse.json({
      item_id: id,
      status: newStatus,
      feedback_id: feedback?.id || null,
      revision_started: verdict === "changes_requested",
    });
  } catch (error) {
    console.error("Content decision error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
