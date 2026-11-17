import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { NextResponse } from "next/server";
import {
  getContentItem,
} from "@/server/db/content";
import { reviseContentItem } from "@/shared/content/contentWorker";
import { runLearn } from "@/shared/content/steps/learn";
import { keepAlive } from "@/server/keepAlive";
import { decideItemStatus, jobStatusForItemStatus } from "@/shared/content/stages";

export const dynamic = "force-dynamic";

const VERDICTS = ["approved", "changes_requested", "rejected"];

/**
 * R5.2.1 / finding B13 — APPROVAL IS NOT PUBLICATION.
 * R5.2.2 — approved items are ready for publish, not yet published.
 *
 * This route used to synthesize a URL on a studio host that publishes nothing
 * (the host is named in docs/BUILD_JOURNAL.md, finding B13, and in
 * src/app/api/content-events/route.js, which quarantines the rows it wrote)
 * and persist it as a `content_events` row, which the lift computation then
 * treated as a real published page: the product reported engagement against a
 * URL that exists nowhere. The synthesis and the write are deleted — and the
 * host name is deliberately absent from this file, so an edit that brings it
 * back has to type the fabrication out. An approved item has NO url; the
 * operator publishes it through POST /api/content-items/[id]/publish with a
 * real verified live URL.
 *
 * @param {string} newStatus the routed item status
 * @returns {{published: false, url: null, reason: string, detail: string}}
 */
function publicationState(newStatus) {
  if (newStatus === "approved") {
    return {
      published: false,
      url: null,
      reason: "approved_not_published",
      detail: "Approved, not published. Use POST /api/content-items/{id}/publish with a live URL to publish.",
    };
  }
  return {
    published: false,
    url: null,
    reason: "not_approved",
    detail: "Not approved, so not published. This item has no URL and no content event.",
  };
}

/**
 * POST /api/content-items/[id]/decision — { verdict, comment }.
 * The human gate: status change + feedback row + learn step (async) +
 * on changes_requested an async revision pass. It publishes nothing and
 * records no URL — see publicationState above.
 */
export async function POST(request, { params }, deps = {}) {
  params = await params;
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

    if (!Number.isInteger(payload.content_version) || typeof payload.content_hash!=="string" || payload.content_version !== item.content_version || payload.content_hash !== item.content_hash) {
      return NextResponse.json({detail:"Draft changed. Refresh before reviewing."},{status:409});
    }
    const admin = (deps.getSupabaseAdmin || getSupabaseAdmin)();
    if (!admin) return NextResponse.json({detail:"Review storage is unavailable."},{status:503});
    const {error} = await admin.rpc("decide_checked_content", {
      p_item:id,p_brand:item.brand,p_version:payload.content_version,p_hash:payload.content_hash,
      p_status:newStatus,p_comment:comment,p_actor:null,
    });
    if(error) return NextResponse.json({detail:"Review was not committed. Check the current draft and its evidence."},{status:409});
    const feedback = null;

    // 3. (deleted) No content_events row is written here. Approval is not
    //    publication; see publicationState above.

    // 4. Learn step — fire-and-forget; a learn failure never blocks the gate.
    if (comment) {
      keepAlive(
        () =>
          runLearn(
            {
              brand: item.brand,
              playbook: item.playbook,
              verdict,
              comment,
              item,
            },
            { sourceFeedbackId: feedback?.id }
          ),
        { label: "[decision] learn step" }
      );
    }

    // 5. Changes requested → async revision pass with the human comment as
    //    the critique. Fire-and-forget; Studio polls the item list.
    if (verdict === "changes_requested") {
      keepAlive(() => reviseContentItem(id, comment), { label: `[decision] revision of item ${id}` });
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
