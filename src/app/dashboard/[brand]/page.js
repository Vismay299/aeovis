"use client";
import Link from "next/link";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {reportResponseState} from "@/shared/reportViewState";
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
  // three-state contract DashboardShell expects, plus `error` for the fourth.
  const [scan, setScan] = useState(undefined);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!brand) {
      setScan(null);
      return;
    }
    let cancelled = false;
    setScan(undefined);
    setError(null);

    fetch(`/api/scans/${encodeURIComponent(brand)}/latest`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;

        // R2.8.4 — a 404 and a failure are different claims.
        //
        // These used to collapse together into the first-run empty state, so a
        // database outage rendered as "Your dashboard is waiting — run your
        // first visibility check". A user with a year of history was told they
        // had never scanned, and invited to spend a scan budget to fix it. Only
        // a 404 means the brand genuinely has no scans; anything else means we
        // could not find out, which is not the same as finding nothing.
        if (res.status === 404) {
          setScan(null);
          return;
        }
        if (!res.ok) {
          setError(`The dashboard could not be loaded (HTTP ${res.status}).`);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        const state=reportResponseState(res.status,data);
        if(!state.scan){setError(state.message);return;}
        setScan(state.scan);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err?.message
            ? `The dashboard could not be loaded (${err.message}).`
            : "The dashboard could not be loaded."
        );
      });

    return () => {
      cancelled = true;
    };
  }, [brand,retry]);

  if(error)return <main role="alert"><h1>Report unavailable</h1><p>{error}</p><button onClick={()=>setRetry(n=>n+1)}>Retry report</button><Link href="/portal/scans">Workspace history</Link></main>;
  return <DashboardShell scan={scan} scanId={scan?.id ?? null} error={error} />;
}
