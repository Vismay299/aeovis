import { NextResponse } from "next/server";
import {
  getContentItem,
  updateContentItem,
  insertContentFeedback,
  updateContentJob,
} from "@/lib/db/content";
import { reviseContentItem } from "@/lib/content/contentWorker";
import { runLearn } from "@/lib/content/steps/learn";
import { decideItemStatus, jobStatusForItemStatus } from "@/lib/content/stages";

export const dynamic = "force-dynamic";

const VERDICTS = ["approved", "changes_requested", "rejected"];

/**
 * R5.2.1 / finding B13 — APPROVAL IS NOT PUBLICATION.
 *
 * This route used to synthesize a URL on a studio host that publishes nothing
 * (the host is named in docs/BUILD_JOURNAL.md, finding B13, and in
 * src/app/api/content-events/route.js, which quarantines the rows it wrote)
 * and persist it as a `content_events` row, which the lift computation then
 * treated as a real published page: the product reported engagement against a
 * URL that exists nowhere. The synthesis and the write are deleted — and the
 * host name is deliberately absent from this file, so an edit that brings it
 * back has to type the fabrication out. An approved item has NO url; the
 * operator publishes it by hand, outside this system, and the verified live
 * URL arrives through the publish step (R5.2.2). Nothing here may invent one,
 * and the wire says so rather than leaving the absence to be inferred from a
 * missing field.
 *
 * @param {string} newStatus the routed item status
 * @returns {{published: false, url: null, reason: string, detail: string}}
 */
function publicationState(newStatus) {
  const approved = newStatus === "approved";
  return {
    published: false,
    url: null,
    reason: approved ? "approved_not_published" : "not_approved",
    detail: approved
      ? "Approved, not published. This item has no URL until it is published for real and that live URL is verified, so no content event was recorded and no lift is attributable to it yet."
      : "Not approved, so not published. This item has no URL and no content event.",
  };
}

/**
 * POST /api/content-items/[id]/decision — { verdict, comment }.
 * The human gate: status change + feedback row + learn step (async) +
 * on changes_requested an async revision pass. It publishes nothing and
 * records no URL — see publicationState above.
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

    // 3. (deleted) No content_events row is written here. Approval is not
    //    publication; see publicationState above.

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
      publication: publicationState(newStatus),
    });
  } catch (error) {
    console.error("Content decision error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
