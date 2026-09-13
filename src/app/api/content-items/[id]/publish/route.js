import { NextResponse } from "next/server";
import {
  getContentItem,
  updateContentItem,
  updateContentJob,
} from "@/lib/db/content";
import { insertContentEvent } from "@/lib/db";
import { isLegalTransition } from "@/lib/content/stages";
import { verifyPublishUrl } from "@/lib/content/publishVerification";

export const dynamic = "force-dynamic";

/**
 * POST /api/content-items/[id]/publish — { url }.
 *
 * R5.2.2 — the explicit publish step. The operator pastes the real live URL;
 * the system verifies it resolves and the content matches before the stage
 * flips to PUBLISHED. Approval is not publication (R5.2.1 / finding B13).
 *
 * Three gates, all of which must pass:
 *   1. The item must be in "approved" status (not already published, not
 *      rejected, not still in draft).
 *   2. The URL must resolve with HTTP 200.
 *   3. The page's <title> must contain the item's title (content match).
 *
 * On success:
 *   - The item status transitions to "published".
 *   - A content_events row is created with the verified URL.
 *   - The job status mirrors to "published".
 *
 * @param {Request} request
 * @param {{ params: { id: string } }} context
 */
export async function POST(request, { params }) {
  try {
    const { id } = params;
    const payload = await request.json().catch(() => ({}));
    const url = (payload.url || "").trim();

    if (!url) {
      return NextResponse.json(
        { detail: "A live URL is required to publish." },
        { status: 400 }
      );
    }

    // 1. Fetch the item
    const item = await getContentItem(id);
    if (!item) {
      return NextResponse.json({ detail: "Item not found." }, { status: 404 });
    }

    // 2. Gate: only approved items can be published
    if (item.status !== "approved") {
      return NextResponse.json(
        {
          detail: `Item is "${item.status}" — only approved items can be published.`,
          current_status: item.status,
        },
        { status: 409 }
      );
    }

    // 3. Verify the URL resolves and content matches
    const verification = await verifyPublishUrl({
      url,
      itemTitle: item.title,
    });

    if (!verification.ok) {
      return NextResponse.json(
        {
          detail: verification.detail || "Publish verification failed.",
          error: verification.error,
          status_code: verification.status || null,
          title_found: verification.title_found || null,
        },
        { status: 422 }
      );
    }

    // 4. Transition to published
    const newStatus = "published";

    // Verify the transition is legal (defense in depth — we already checked
    // status above, but the stage machine is the authority)
    if (!isLegalTransition(item.status, newStatus)) {
      return NextResponse.json(
        { detail: `Cannot transition from "${item.status}" to "${newStatus}".` },
        { status: 409 }
      );
    }

    await updateContentItem(id, { status: newStatus });

    // 5. Record the content event (this is the REAL publication event,
    //    unlike the fabricated one deleted in R5.2.1)
    let contentEvent = null;
    try {
      contentEvent = await insertContentEvent({
        brand: item.brand,
        url,
      });
    } catch (eventErr) {
      // Event write failure must not block the publish — log and continue.
      console.error(`[publish] failed to write content event for item ${id}:`, eventErr);
    }

    // 6. Mirror job status
    if (item.job_id) {
      try {
        await updateContentJob(item.job_id, { status: "published" });
      } catch (jobErr) {
        console.warn("[publish] job status sync failed:", jobErr.message);
      }
    }

    return NextResponse.json({
      item_id: id,
      status: newStatus,
      url,
      published: true,
      content_event_id: contentEvent?.id || null,
      verification: {
        status: verification.status,
        title_found: verification.title_found,
      },
    });
  } catch (error) {
    console.error("Content publish error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
