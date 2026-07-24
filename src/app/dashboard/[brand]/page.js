"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import DashboardShell from "@/components/dashboard/DashboardShell";

/**
 * /dashboard/[brand] — P0.3 server-backed dashboard: loads the brand's most
 * recent scan from the server on mount (client fetch, matching this
 * codebase's all-client dashboard idiom) instead of reading sessionStorage.
 *
 * `[brand]` is the display brand name, URL-encoded — matching the existing
 * /api/scans/[brand] ilike lookup convention, NOT the domain key
 * resolveBrandKey() produces for the analytics endpoints
 * (/api/brands/[brand]/metrics, /schedule). If a later package wires those
 * in here, derive that key from the loaded scan with
 * resolveBrandKey(scan.brand, scan.website) — it needs the url, which this
 * route's path param alone doesn't carry.
 */
export default function BrandDashboardPage() {
  const params = useParams();
  // useParams() is inconsistent about whether a dynamic segment arrives
  // already decoded (plain "italica") or still percent-encoded (observed for
  // segments containing spaces, e.g. "P03%20Verify%20Retry") — decode
  // defensively before re-encoding for the fetch below, otherwise a brand
  // name with spaces or other reserved characters gets double-encoded
  // ("%2520...") and 404s. A stray literal "%" in a brand name (not part of
  // a real escape sequence) would throw here; fall back to the raw value.
  const rawBrand = params?.brand || "";
  let brand = rawBrand;
  try {
    brand = decodeURIComponent(rawBrand);
  } catch {
    /* not actually encoded — use as-is */
  }

  // undefined = loading, null = nothing to show, object = ready — the
  // three-state contract DashboardShell expects.
  const [scan, setScan] = useState(undefined);

  useEffect(() => {
    if (!brand) {
      setScan(null);
      return;
    }
    let cancelled = false;
    setScan(undefined);

    fetch(`/api/scans/${encodeURIComponent(brand)}/latest`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // 404 (no scans yet) and any transient error both collapse to the
          // shell's existing empty state — no new UI for this package.
          setScan(null);
          return;
        }
        const data = await res.json();
        setScan(data.scan || null);
      })
      .catch(() => {
        if (!cancelled) setScan(null);
      });

    return () => {
      cancelled = true;
    };
  }, [brand]);

  return <DashboardShell scan={scan} scanId={scan?.id ?? null} />;
}
