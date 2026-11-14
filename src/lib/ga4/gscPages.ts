// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/SearchOpportunityService.ts (GSC half)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../http/appError.ts";
import { gscFetchForBrand } from "../engines/gsc.js";

const gscPageRowSchema = z.looseObject({
  keys: z.array(z.string()),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
});

export type GscPageRow = z.infer<typeof gscPageRowSchema>;

export type GscFetchForBrandFn = typeof gscFetchForBrand;

export type GscPagesDeps = {
  gscFetch?: GscFetchForBrandFn;
};

function brandKeyOf(ws: unknown): string {
  if (typeof ws === "string") return ws;
  if (ws && typeof ws === "object") {
    const o = ws as Record<string, unknown>;
    if (typeof o.brandKey === "string") return o.brandKey;
    if (typeof o.brand_key === "string") return o.brand_key;
  }
  return "";
}

/**
 * Reads one live Search Console `page` report for the workspace's connected
 * property. Read-only: no write to any GSC table. The caller injects
 * `gscFetch` in tests so no live call happens; the route wires the real
 * `gscFetchForBrand`.
 */
export async function fetchGscPageRows(
  admin: any,
  ws: unknown,
  { startDate, endDate }: { startDate: string; endDate: string },
  deps: GscPagesDeps = {},
): Promise<{ siteUrl: string; rows: GscPageRow[] }> {
  const brandKey = brandKeyOf(ws) || (typeof ws === "string" ? ws : "");

  const { data: conn, error } = await admin
    .from("gsc_connections")
    .select("brand_key, enabled, auth_mode, site_url, connection_generation")
    .eq("brand_key", brandKey)
    .maybeSingle();

  if (error || !conn || !conn.enabled || conn.auth_mode !== "oauth") {
    throw new AppError(
      409,
      "gsc_not_connected",
      "Connect Search Console to see search opportunities.",
    );
  }

  const siteUrl = conn.site_url as string;
  const fetchImpl = deps.gscFetch ?? gscFetchForBrand;

  let data: any;
  try {
    data = await fetchImpl(
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
    // 401/403 from the API ("GSC access denied ...") and every token failure
    // that tells the customer to reconnect (revoked, missing refresh token,
    // undecryptable credential, no active authorization) need a reconnect,
    // not a retry.
    if (
      msg.includes("access denied") ||
      /reconnect/i.test(msg) ||
      msg.includes("No active Google authorization")
    ) {
      throw new AppError(
        409,
        "gsc_reconnect_required",
        "Search Console access was lost. Reconnect it on the Search Console page.",
      );
    }
    if (msg.includes("HTTP 429")) {
      throw new AppError(
        429,
        "gsc_quota_exhausted",
        "Search Console's quota is used up for now.",
        { recovery: "Try again later." },
      );
    }
    throw new AppError(
      503,
      "gsc_unavailable",
      "Search Console is unavailable right now.",
      { recovery: "Please retry." },
    );
  }

  const rawRows = Array.isArray(data?.rows) ? data.rows : [];
  const rows: GscPageRow[] = [];
  for (const row of rawRows) {
    const parsed = gscPageRowSchema.safeParse(row);
    if (parsed.success) rows.push(parsed.data);
  }

  return { siteUrl, rows };
}
