"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { loadScan, clearScan } from "@/services/api";

/**
 * /dashboard — legacy one-time migration shim (P0.3).
 *
 * The dashboard used to live entirely at this URL, reading its scan record
 * out of sessionStorage (`aeo_last_scan`). Real scan viewing now happens at
 * server-backed URLs — /dashboard/[brand] and /dashboard/[brand]/[scanId] —
 * so results are shareable by URL and don't risk the ~5MB sessionStorage
 * quota a large multi-engine record can approach. This route now only
 * bridges callers that still write to sessionStorage and push here:
 *
 *   - src/app/scan/page.js  (a fresh scan just completed, and its sample card)
 *   - the landing page's "see a sample report" button (src/app/page.js)
 *     — SAMPLE_RESULT, isSample: true
 *
 * Sample reports are deliberately NOT part of the redirect: they're
 * synthetic (no DB row, nothing to fetch), so this route renders them
 * directly with zero server round-trip and leaves them in sessionStorage —
 * unlike a real scan, refreshing /dashboard while viewing a sample must keep
 * working exactly as it does today. Every other record is read ONCE, used
 * to derive a target /dashboard/[brand] (or /dashboard/[brand]/[scanId]
 * when the record carries an id), redirected to via router.replace() with
 * the current query string (?view=/?item=) preserved, and then the
 * sessionStorage key is cleared — from here on sessionStorage is a one-shot
 * handoff, never a read source for normal dashboard viewing again.
 */
export default function LegacyDashboardRedirect() {
  const router = useRouter();
  // "checking"  — deciding what to do, or a redirect is in flight
  // "sample"    — render the sample record inline, no fetch
  // "empty"     — nothing in sessionStorage (or it was unusable)
  const [mode, setMode] = useState("checking");
  const [sampleScan, setSampleScan] = useState(null);

  useEffect(() => {
    const current = loadScan();

    if (!current) {
      setMode("empty");
      return;
    }

    if (current.isSample) {
      // Sample-report path: render directly, no redirect, no server fetch.
      // Intentionally left in sessionStorage (see file comment above).
      setSampleScan(current);
      setMode("sample");
      return;
    }

    const brand = current.brand;
    if (!brand) {
      // Malformed/legacy record with nothing to key a URL off of.
      clearScan();
      setMode("empty");
      return;
    }

    const id = current.id || current.scan_id || current.scanId || null;
    const target = id
      ? `/dashboard/${encodeURIComponent(brand)}/${encodeURIComponent(id)}`
      : `/dashboard/${encodeURIComponent(brand)}`;
    const qs = typeof window !== "undefined" ? window.location.search : "";

    clearScan();
    router.replace(qs ? `${target}${qs}` : target);
  }, [router]);

  if (mode === "sample") {
    return <DashboardShell scan={sampleScan} />;
  }
  if (mode === "empty") {
    return <DashboardShell scan={null} />;
  }
  // "checking" — includes the brief instant before a redirect actually
  // navigates away. Reuse the shell's own loading skeleton (scan=undefined).
  return <DashboardShell scan={undefined} />;
}
