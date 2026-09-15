import { NextResponse } from "next/server";
import { getContentItem } from "@/lib/db/content";
import { getScansForBrand } from "@/lib/db";
import { normalizeScanRows } from "@/lib/content/steps/shared";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function queryKey(t) {
  return String(t || "").toLowerCase().trim();
}

/**
 * GET /api/content-items/[id]/lift — GEO lift for an approved geo_article,
 * computed from the item's target_queries against scans since approval.
 * "target queries: 3 → visible on 1 since publish" (plan Phase 4).
 */
export async function GET(request, { params }) {
  try {
    const { id } = params;
    const item = await getContentItem(id);
    if (!item) {
      return NextResponse.json({ detail: "Item not found." }, { status: 404 });
    }
    if (item.playbook !== "geo_article") {
      return NextResponse.json({ applicable: false });
    }

    const targets = (item.target_queries || []).map(queryKey).filter(Boolean);
    if (targets.length === 0) {
      return NextResponse.json({ applicable: false });
    }

    const scans = await getScansForBrand(item.brand);
    const approvedAt = new Date(item.updated_at || item.created_at).getTime();

    // Baseline = latest scan at/before approval; current = latest scan after.
    const sorted = [...(scans || [])].sort(
      (a, b) => new Date(a.scanned_at) - new Date(b.scanned_at)
    );
    const before = [...sorted].reverse().find((s) => new Date(s.scanned_at).getTime() <= approvedAt);
    const after = sorted.find((s) => new Date(s.scanned_at).getTime() > approvedAt);

    const targetSet = new Set(targets);
    const countVisibleCited = (scan) => {
      if (!scan) return { visible: 0, cited: 0, matched: 0 };
      const rows = normalizeScanRows(scan).filter((r) => targetSet.has(queryKey(r.prompt)));
      // Collapse multi-engine rows: a query is "visible" if visible on ANY engine
      // whose answer actually succeeded. R2.7.17 — an errored row's visible flag
      // may be true from a surviving search leg (probeResultContract:397), but
      // lift only accrues from a scan whose answer leg survived.
      const byQuery = new Map();
      for (const r of rows) {
        if (!r.answer_present) continue;
        const k = queryKey(r.prompt);
        const e = byQuery.get(k) || { visible: false, cited: false };
        e.visible = e.visible || r.visible;
        e.cited = e.cited || r.brand_cited;
        byQuery.set(k, e);
      }
      let visible = 0;
      let cited = 0;
      for (const v of byQuery.values()) {
        if (v.visible) visible++;
        if (v.cited) cited++;
      }
      return { visible, cited, matched: byQuery.size };
    };

    const beforeCounts = countVisibleCited(before);
    const afterCounts = countVisibleCited(after);

    return NextResponse.json(
      {
        applicable: true,
        target_count: targets.length,
        approved_at: item.updated_at || item.created_at,
        has_post_scan: !!after,
        before: beforeCounts,
        after: afterCounts,
        cited_delta: afterCounts.cited - beforeCounts.cited,
        visible_delta: afterCounts.visible - beforeCounts.visible,
        post_scan_at: after?.scanned_at || null,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Content lift error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}
