// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/SearchOpportunityService.ts (GSC half)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { gscFetchForBrand } from "../engines/gsc.js";

function brandKeyOf(ws: unknown): string {
  if (typeof ws === "string") return ws;
  if (ws && typeof ws === "object") {
    const o = ws as Record<string, unknown>;
    if (typeof o.brandKey === "string") return o.brandKey;
    if (typeof o.brand_key === "string") return o.brand_key;
  }
  return "";
}

export async function fetchGscPageRows(
  admin: any,
  ws: unknown,
  { startDate, endDate }: { startDate: string; endDate: string },
): Promise<{ siteUrl: string; rows: any[] }> {
  const brandKey = brandKeyOf(ws) || (typeof ws === "string" ? ws : "");

  const { data: conn, error } = await admin
    .from("gsc_connections")
    .select("*")
    .eq("brand_key", brandKey)
    .maybeSingle();

  if (error || !conn || !conn.enabled || conn.auth_mode !== "oauth") {
    throw new AppError(409, "gsc_not_connected", "Connect Search Console to see search opportunities.");
  }

  const siteUrl = conn.site_url;

  let data: any;
  try {
    data = await gscFetchForBrand(
      siteUrl,
      {
        method: "POST",
        body: JSON.stringify({
          startDate,
          endDate,
          dimensions: ["page"],
          rowLimit: 1000,
          startRow: 0,
          type: "web",
          dataState: "final",
        }),
      },
      { brandKey, admin, authMode: "oauth" },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("access denied") || msg.includes("401") || msg.includes("403")) {
      throw new AppError(409, "gsc_reconnect_required", "Search Console access was lost. Reconnect it on the Search Console page.");
    }
    if (msg.includes("429")) {
      throw new AppError(429, "gsc_quota_exhausted", "Search Console's quota is used up for now.");
    }
    throw new AppError(503, "gsc_unavailable", "Search Console is unavailable right now.");
  }

  const rows = (data?.rows ?? []).map((r: any) => ({
    keys: r.keys ?? [],
    clicks: typeof r.clicks === "number" ? r.clicks : 0,
    impressions: typeof r.impressions === "number" ? r.impressions : 0,
    ctr: typeof r.ctr === "number" ? r.ctr : 0,
    position: typeof r.position === "number" ? r.position : 0,
  }));

  return { siteUrl, rows };
}