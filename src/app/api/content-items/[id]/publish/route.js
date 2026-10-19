import { NextResponse } from "next/server";
import { getContentItem } from "@/lib/db/content";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { repairWorkflowStore } from "@/lib/db/repairWorkflow";
import { verifyPublishUrl } from "@/lib/content/publishVerification";
export const dynamic = "force-dynamic";
// Operator perimeter authenticates this route; the transaction applies the same
// exact-version, body and event guarantees as customer publication.
export async function POST(request, { params }, deps = {}) {
  const { id } = await params;
  const payload = await request.json().catch(() => ({}));
  if (typeof payload.url !== "string" || !payload.url.trim())
    return NextResponse.json(
      { detail: "A live URL is required." },
      { status: 400 },
    );
  const item = await (deps.getContentItem || getContentItem)(id);
  if (!item)
    return NextResponse.json({ detail: "Item not found." }, { status: 404 });
  if (
    !Number.isInteger(payload.content_version) ||
    typeof payload.content_hash !== "string" ||
    payload.content_version !== item.content_version ||
    payload.content_hash !== item.content_hash
  )
    return NextResponse.json(
      { detail: "Draft changed. Refresh before publishing." },
      { status: 409 },
    );
  if (!["approved", "published"].includes(item.status))
    return NextResponse.json(
      { detail: "Approve the checked draft first." },
      { status: 409 },
    );
  const admin = (deps.getSupabaseAdmin || getSupabaseAdmin)();
  if (!admin)
    return NextResponse.json(
      { detail: "Publication storage is unavailable." },
      { status: 503 },
    );
  const verification = await (deps.verifyPublishUrl || verifyPublishUrl)({
    url: payload.url,
    itemTitle: item.title,
    itemBody: item.body_md,
  });
  if (!verification.ok)
    return NextResponse.json(
      {
        detail: verification.detail || "Body verification failed.",
        error: verification.error,
      },
      { status: 422 },
    );
  try {
    const publication = await repairWorkflowStore(admin).publish({
      p_item: id,
      p_brand: item.brand,
      p_version: item.content_version,
      p_hash: item.content_hash,
      p_url: verification.final_url,
      p_verification: verification,
      p_key: payload.idempotency_key || `${id}:${item.content_version}`,
      p_actor: null,
    });
    return NextResponse.json({
      item_id: id,
      status: "published",
      published: true,
      url: publication.url,
      publication,
      verification,
      indexing: null,
      observed_citation: null,
    });
  } catch {
    return NextResponse.json(
      {
        detail:
          "Publication was not committed. Refresh and retry the same version.",
      },
      { status: 409 },
    );
  }
}
