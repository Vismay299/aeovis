"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import DashboardShell from "@/components/dashboard/DashboardShell";

/**
 * /dashboard/[brand]/[scanId] — P0.3 server-backed dashboard, pinned to one
 * specific scan rather than "whatever is latest".
 *
 * `[brand]` is cosmetic here (display brand name, for a readable URL) — the
 * fetch is keyed entirely on `[scanId]`, the `scans.id` uuid. See
 * /dashboard/[brand]/page.js for the brand-key vs analytics domain-key note.
 */
export default function BrandScanDashboardPage() {
  const params = useParams();
  const scanId = params?.scanId || "";

  // undefined = loading, null = nothing to show, object = ready — the
  // three-state contract DashboardShell expects.
  const [scan, setScan] = useState(undefined);

  useEffect(() => {
    if (!scanId) {
      setScan(null);
      return;
    }
    let cancelled = false;
    setScan(undefined);

    fetch(`/api/scans/by-id/${encodeURIComponent(scanId)}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
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
  }, [scanId]);

  return <DashboardShell scan={scan} scanId={scanId || null} />;
}
