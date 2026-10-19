"use client";

/**
 * Customer portal shell: auth + workspace membership, the light sidebar, and
 * one shared data context every /portal page reads through usePortal().
 *
 * The shell inherits the same light root palette as the public website.
 */

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard, Radar, PenLine, Search, Users, LogOut, ChevronsUpDown, Loader2,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useScanTracker } from "./useScanTracker";
import { Button, Card, ProgressBar, Spinner, TopLoadingBar } from "./ui";

export const PortalContext = createContext(null);

/**
 * {
 *   user: { id, email },
 *   brands: [{ brandKey, role, display_name, website }],
 *   brand, brandKey, setBrandKey(key), isOwner,
 *   overview,        // GET /api/customer/overview body, or null while loading
 *   overviewLoading, overviewError, refreshOverview(),
 *   gsc,             // GET /api/customer/gsc body, or null
 *   refreshGsc(),
 *   scan,            // see useScanTracker's return value
 *   redirectToLogin(), signOut(),
 * }
 */
export function usePortal() {
  const context = useContext(PortalContext);
  if (!context) throw new Error("usePortal() must be used inside <PortalShell>.");
  return context;
}

const BRAND_STORAGE_KEY = "perceev-portal-brand";

const NAV = [
  { href: "/portal", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/portal/scans", label: "Scans", icon: Radar, meta: "scan" },
  { href: "/portal/measurement", label: "Questions & evidence", icon: Search },
  { href: "/portal/content", label: "Content Studio", icon: PenLine, meta: "content" },
  { href: "/portal/search-console", label: "Search Console", icon: Search, meta: "gsc" },
];

const SETTINGS_NAV = [{ href: "/portal/team", label: "Team", icon: Users, ownerOnly: true }];

function readStoredBrand() {
  try { return window.localStorage.getItem(BRAND_STORAGE_KEY) || ""; } catch { return ""; }
}

function storeBrand(key) {
  try { window.localStorage.setItem(BRAND_STORAGE_KEY, key); } catch { /* storage unavailable */ }
}

export default function PortalShell({ children }) {
  const router = useRouter();
  const pathname = usePathname() || "/portal";

  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [bootError, setBootError] = useState("");
  const [user, setUser] = useState(null);
  const [brands, setBrands] = useState([]);
  const [brandKey, setBrandKeyState] = useState("");
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [gsc, setGsc] = useState(null);

  const loginPath = `/login?next=${encodeURIComponent(pathname)}`;
  const redirectToLogin = useCallback(() => router.replace(loginPath), [router, loginPath]);

  // Google's OAuth callback lands on /portal; the property picker lives on
  // the Search Console page, so forward the callback parameters there.
  useEffect(() => {
    if (pathname !== "/portal") return;
    const params = new URLSearchParams(window.location.search);
    if (params.has("gsc_attempt") || params.has("gsc_error") || params.has("gsc_connected")) {
      router.replace(`/portal/search-console${window.location.search}`);
    }
  }, [pathname, router]);

  useEffect(() => {
    let live = true;
    async function boot() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        setBootError("Customer login is not configured on this deployment yet.");
        setPhase("error");
        return;
      }
      const { data: { user: signedIn } = {} } = await supabase.auth.getUser();
      if (!live) return;
      if (!signedIn) {
        router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      const { error: inviteError } = await supabase.rpc("accept_customer_team_invites");
      if (!live) return;
      if (inviteError) {
        setBootError("We could not check your workspace invitations. Please refresh the page.");
        setPhase("error");
        return;
      }
      const { data: memberships, error: membershipError } = await supabase
        .from("customer_brand_memberships")
        .select("brand_key, role, customer_brands!inner(brand_key, display_name, website, is_active)")
        .eq("user_id", signedIn.id)
        .eq("customer_brands.is_active", true)
        .order("brand_key");
      if (!live) return;
      if (membershipError) {
        setBootError("We could not load your workspace access. Please refresh the page.");
        setPhase("error");
        return;
      }
      const assigned = (memberships || []).map((row) => ({
        brandKey: row.brand_key,
        role: row.role,
        ...(Array.isArray(row.customer_brands) ? row.customer_brands[0] : row.customer_brands),
      }));
      const fromUrl = new URLSearchParams(window.location.search).get("brand_key");
      const stored = readStoredBrand();
      const initial =
        assigned.find((item) => item.brandKey === fromUrl)?.brandKey ||
        assigned.find((item) => item.brandKey === stored)?.brandKey ||
        assigned[0]?.brandKey ||
        "";
      setUser({ id: signedIn.id, email: signedIn.email || "" });
      setBrands(assigned);
      setBrandKeyState(initial);
      setPhase("ready");
    }
    boot().catch(() => {
      if (!live) return;
      setBootError("We could not load your workspace. Please refresh the page.");
      setPhase("error");
    });
    return () => { live = false; };
  }, [router]);

  const brand = useMemo(() => brands.find((item) => item.brandKey === brandKey) || null, [brands, brandKey]);
  const isOwner = brand?.role === "owner";

  const setBrandKey = useCallback((key) => {
    setBrandKeyState(key);
    setOverview(null);
    setGsc(null);
    storeBrand(key);
  }, []);

  const refreshOverview = useCallback(async () => {
    if (!brandKey) return;
    setOverviewLoading(true);
    try {
      const response = await fetch(`/api/customer/overview?brand_key=${encodeURIComponent(brandKey)}`, { cache: "no-store" });
      if (response.status === 401) { redirectToLogin(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load your workspace.");
      setOverview(body);
      setOverviewError("");
    } catch (loadError) {
      setOverviewError(loadError.message || "Could not load your workspace.");
    } finally {
      setOverviewLoading(false);
    }
  }, [brandKey, redirectToLogin]);

  const refreshGsc = useCallback(async () => {
    if (!brandKey) return;
    try {
      const response = await fetch(`/api/customer/gsc?brand_key=${encodeURIComponent(brandKey)}`, { cache: "no-store" });
      if (response.status === 401) { redirectToLogin(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not read your Search Console connection.");
      setGsc(body);
    } catch (gscError) {
      // Settle to "not connected" with the reason, so no page waits forever.
      setGsc({ connected: false, connection: null, error: gscError.message || "Could not read your Search Console connection." });
    }
  }, [brandKey, redirectToLogin]);

  useEffect(() => {
    if (phase !== "ready" || !brandKey) return;
    storeBrand(brandKey);
    refreshOverview();
    refreshGsc();
  }, [phase, brandKey, refreshOverview, refreshGsc]);

  const scan = useScanTracker({
    brandKey,
    jobs: overview?.scan_jobs,
    onFinished: refreshOverview,
    onUnauthorized: redirectToLogin,
  });

  const signOut = useCallback(async () => {
    await getSupabaseBrowserClient()?.auth.signOut();
    router.replace("/login");
  }, [router]);

  const value = useMemo(() => ({
    user, brands, brand, brandKey, setBrandKey, isOwner,
    overview, overviewLoading, overviewError, refreshOverview,
    gsc, refreshGsc, scan, redirectToLogin, signOut,
  }), [user, brands, brand, brandKey, setBrandKey, isOwner, overview, overviewLoading, overviewError, refreshOverview, gsc, refreshGsc, scan, redirectToLogin, signOut]);

  if (phase === "loading") {
    return (
      <div className="pv-center">
        <TopLoadingBar show />
        <div className="pv-row pv-muted"><Spinner label="Loading your workspace" /> Loading your workspace…</div>
      </div>
    );
  }

  if (phase === "error" || !brands.length) {
    return (
      <div className="pv-center">
        <Card
          title={phase === "error" ? "Workspace unavailable" : "Your account is ready"}
          description={phase === "error" ? bootError : "Finish setting up your workspace to start tracking how AI engines talk about your brand."}
        >
          <div className="pv-row">
            {phase === "error"
              ? <Button onClick={() => window.location.reload()}>Retry</Button>
              : <Button href="/onboarding">Set up my workspace</Button>}
            <Button variant="ghost" onClick={signOut}>Sign out</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <PortalContext.Provider value={value}>
      <PortalFrame>{children}</PortalFrame>
    </PortalContext.Provider>
  );
}

/** The light sidebar + main canvas. Reads everything from usePortal(). */
export function PortalFrame({ children }) {
  const pathname = usePathname() || "/portal";
  const { user, brands, brand, brandKey, setBrandKey, isOwner, overview, overviewLoading, gsc, scan, signOut } = usePortal();

  const awaitingReview = (overview?.content_items || []).filter((item) => item.status === "awaiting_approval").length;
  const navMeta = {
    scan: scan.active ? <span className="pv-nav__live"><Loader2 aria-hidden="true" style={{ width: 12, height: 12, animation: "pv-spin .9s linear infinite" }} />{scan.percent === null ? "" : `${Math.round(scan.percent)}%`}</span> : null,
    content: awaitingReview ? <span className="pv-nav__meta">{awaitingReview}</span> : null,
    gsc: gsc ? <span className="pv-nav__meta" style={{ color: gsc.connected ? "var(--good)" : "var(--ink-4)" }}>{gsc.connected ? "●" : "○"}</span> : null,
  };

  const isActive = (item) => (item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <div className="pv-app">
      <aside className="pv-sidebar" aria-label="Workspace navigation">
        <Link href="/portal" className="pv-sidebar__logo"><i aria-hidden="true" />perceev</Link>

        <div className="pv-workspace">
          <span className="pv-workspace__avatar" aria-hidden="true">{(brand?.display_name || "?").slice(0, 1)}</span>
          <span className="pv-workspace__text">
            <span className="pv-workspace__name">{brand?.display_name || "Workspace"}</span>
            <span className="pv-workspace__site">{brand?.website ? brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "") : brand?.role}</span>
          </span>
          {brands.length > 1 ? (
            <>
              <ChevronsUpDown className="pv-workspace__chevron" aria-hidden="true" width={15} height={15} />
              <label className="sr-only" htmlFor="pv-workspace-select">Switch workspace</label>
              <select id="pv-workspace-select" value={brandKey} onChange={(event) => setBrandKey(event.target.value)}>
                {brands.map((item) => <option key={item.brandKey} value={item.brandKey}>{item.display_name}</option>)}
              </select>
            </>
          ) : null}
        </div>

        <nav className="pv-nav">
          <span className="pv-nav__label">Workspace</span>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={`pv-nav__item${isActive(item) ? " is-active" : ""}`} aria-current={isActive(item) ? "page" : undefined}>
              <item.icon aria-hidden="true" />
              {item.label}
              {item.meta ? navMeta[item.meta] : null}
            </Link>
          ))}
          {SETTINGS_NAV.some((item) => !item.ownerOnly || isOwner) ? <span className="pv-nav__label" style={{ marginTop: 14 }}>Settings</span> : null}
          {SETTINGS_NAV.filter((item) => !item.ownerOnly || isOwner).map((item) => (
            <Link key={item.href} href={item.href} className={`pv-nav__item${isActive(item) ? " is-active" : ""}`} aria-current={isActive(item) ? "page" : undefined}>
              <item.icon aria-hidden="true" />
              {item.label}
            </Link>
          ))}
        </nav>

        {scan.active && !pathname.startsWith("/portal/scans") && pathname !== "/portal" ? (
          <Link href="/portal/scans" className="pv-sidebar__scan">
            <b><span>Scan running</span><span className="pv-num">{scan.percent === null ? "—" : `${Math.round(scan.percent)}%`}</span></b>
            <ProgressBar value={scan.percent} active indeterminate size="sm" label="Scan progress" />
            <span>{scan.stage?.label || "Starting"}…</span>
          </Link>
        ) : null}

        <div className="pv-sidebar__foot">
          <span className="pv-user__avatar" aria-hidden="true">{(user?.email || "?").slice(0, 1)}</span>
          <span className="pv-user__email" title={user?.email}>{user?.email}</span>
          <button type="button" className="pv-icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut aria-hidden="true" />
          </button>
        </div>
      </aside>

      <main className="pv-main">
        <TopLoadingBar show={overviewLoading && !overview} />
        {children}
      </main>
    </div>
  );
}
