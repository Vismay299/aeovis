"use client";

/**
 * Customer portal shell: auth + workspace membership, the app sidebar, and one
 * shared data context every /portal page reads through usePortal().
 *
 * The shell inherits the app palette (light or dark, per browser preference)
 * rather than the public website's fixed light one.
 */

import "@/components/portal/portal.css";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { setTelemetryIdentity, resetTelemetry } from "@/lib/telemetry/client";
import { ConsentBanner } from "@/components/app/telemetry/ConsentBanner";
import { useScanTracker } from "./useScanTracker";
import { prefetchPriceQuote } from "@/components/app/cost/usePriceQuote";
import { ScanCostReview } from "./ScanCostReview";
import { AppShell } from "@/components/app/shell/AppShell";
import { PageFrame } from "@/components/app/PageFrame";
import { StatusScreen } from "@/components/app/StatusScreen";
import { SkeletonPageContent } from "@/components/app/SkeletonPresets";
import { AppBanner } from "@/components/app/AppBanner";
import { Button } from "@/components/ui/button";
import { TopLoadingBar } from "./ui";
import { keys } from "@/lib/query/keys";
import {
  featuresQueryOptions,
  overviewQueryOptions,
  gscQueryOptions,
} from "@/lib/query/portalQueries";
import { describeError } from "@/lib/query/errors";
import { setUnauthorizedHandler } from "@/lib/query/fetchJson";
import { WorkspaceProvider } from "@/components/app/workspace/WorkspaceContext";

/**
 * @typedef {Object} PortalBrand
 * @property {string} brandKey
 * @property {"owner" | "member"} role
 * @property {string} display_name
 * @property {string} website
 */

/**
 * @typedef {Object} PortalScan
 * @property {boolean} active
 * @property {boolean} [starting]
 * @property {number | null} percent
 * @property {{ label: string } | null} stage
 * @property {() => void} start
 * @property {(maxUsd?: number) => Promise<void>} confirmStart
 * @property {() => void} cancelReview
 * @property {{ open: boolean, priceChanged: { approvedMaxUsd: number, quote: import("@/shared/pricing").PriceQuote } | null, error: string | null }} review
 * @property {() => void} dismiss
 */

/**
 * @typedef {Object} PortalValue
 * @property {{ id: string, email: string } | null} user
 * @property {PortalBrand[]} brands
 * @property {PortalBrand | null} brand
 * @property {string} brandKey
 * @property {(key: string) => void} setBrandKey
 * @property {boolean} isOwner
 * @property {any} overview
 * @property {boolean} overviewLoading
 * @property {string} overviewError
 * @property {() => Promise<void>} refreshOverview
 * @property {any} gsc
 * @property {() => Promise<void>} refreshGsc
 * @property {PortalScan} scan
 * @property {Record<string, boolean> | null} features
 * @property {() => void} redirectToLogin
 * @property {() => Promise<void>} signOut
 */

/** @type {import("react").Context<PortalValue | null>} */
export const PortalContext = createContext(
  /** @type {PortalValue | null} */ (null)
);

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
 *   features,        // GET /api/customer/features body, or null before it lands
 *   redirectToLogin(), signOut(),
 * }
 *
 * @returns {PortalValue}
 */
export function usePortal() {
  const context = useContext(PortalContext);
  if (!context) throw new Error("usePortal() must be used inside <PortalShell>.");
  return context;
}

const BRAND_STORAGE_KEY = "perceev-portal-brand";

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

  const queryClient = useQueryClient();
  if (typeof window !== "undefined") {
    window.__REACT_QUERY_CLIENT__ = queryClient;
  }

  // The redirect reads the CURRENT location at the moment it happens, so this
  // callback never changes identity. That matters: the effect below loads the
  // workspace's data, and a callback that changed on every navigation would
  // reload it on every navigation too — and would read the feature flags more
  // than once for the same workspace.
  const redirectToLogin = useCallback(() => {
    const next =
      typeof window === "undefined"
        ? "/portal"
        : `${window.location.pathname}${window.location.search}`;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [router]);

  const redirectedRef = useRef(false);
  useEffect(() => {
    const redirectOnce = () => {
      if (redirectedRef.current) return;
      redirectedRef.current = true;
      const next =
        typeof window === "undefined"
          ? "/portal"
          : `${window.location.pathname}${window.location.search}`;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    };
    setUnauthorizedHandler(() => redirectOnce());
    return () => setUnauthorizedHandler(null);
  }, [router]);

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
        .select("brand_key, role, customer_brands!inner(brand_key, display_name, website, is_active, telemetry_id)")
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
    storeBrand(key);
  }, []);

  const queryEnabled = phase === "ready" && Boolean(brandKey);

  const featuresQuery = useQuery({
    ...featuresQueryOptions(brandKey),
    enabled: queryEnabled,
  });
  const overviewQuery = useQuery({
    ...overviewQueryOptions(brandKey),
    enabled: queryEnabled,
  });
  const gscQuery = useQuery({
    ...gscQueryOptions(brandKey),
    enabled: queryEnabled,
  });

  const overview = overviewQuery.data ?? null;
  const overviewLoading = overviewQuery.isFetching;
  const overviewError = overviewQuery.isError
    ? describeError(overviewQuery.error, "Could not load your workspace.")
    : "";
  const overviewQueryError = overviewQuery.error;
  const refreshOverview = useCallback(
    () => queryClient.invalidateQueries({ queryKey: keys.overview(brandKey) }),
    [queryClient, brandKey]
  );

  const gsc = gscQuery.isError
    ? {
        connected: false,
        connection: null,
        error: describeError(
          gscQuery.error,
          "Could not read your Search Console connection."
        ),
      }
    : gscQuery.data ?? null;
  const refreshGsc = useCallback(
    () => queryClient.invalidateQueries({ queryKey: keys.gsc(brandKey) }),
    [queryClient, brandKey]
  );

  const features = featuresQuery.data?.features ?? null;
  const priceReview = Boolean(features?.price_review);

  useEffect(() => {
    if (brandKey && priceReview) {
      prefetchPriceQuote(queryClient, {
        brandKey,
        action: "ai_visibility.scan.run",
        input: { panelKey: "default" },
      });
    }
  }, [brandKey, priceReview, queryClient]);

  const scan = useScanTracker({
    brandKey,
    jobs: overview?.scan_jobs,
    onFinished: refreshOverview,
    onUnauthorized: redirectToLogin,
    priceReview,
  });

  useEffect(() => {
    if (user?.id && brand) {
      setTelemetryIdentity({
        userId: user.id,
        workspaceTelemetryId: brand.telemetry_id ?? null,
      });
    }
  }, [user?.id, brand?.brandKey, brand?.telemetry_id]);

  const signOut = useCallback(async () => {
    resetTelemetry();
    await getSupabaseBrowserClient()?.auth.signOut();
    router.replace("/login");
  }, [router]);


  const value = useMemo(() => ({
    user, brands, brand, brandKey, setBrandKey, isOwner,
    overview, overviewLoading, overviewError, overviewQueryError, refreshOverview,
    gsc, refreshGsc, scan, features, redirectToLogin, signOut,
  }), [user, brands, brand, brandKey, setBrandKey, isOwner, overview, overviewLoading, overviewError, overviewQueryError, refreshOverview, gsc, refreshGsc, scan, features, redirectToLogin, signOut]);

  if (phase === "loading") {
    // The shell renders before the session is confirmed, so the sidebar keeps
    // its shape from the first paint: the logo, the switcher's skeleton and
    // placeholder nav rows, with the content showing the page skeleton. The
    // reader never watches the page jump into place.
    return (
      <PortalContext.Provider value={value}>
        <WorkspaceProvider value={{ brandKey, features, isOwner }}>
          <AppShell ready={false}>
            <PageFrame>
              <SkeletonPageContent />
            </PageFrame>
          </AppShell>
        </WorkspaceProvider>
      </PortalContext.Provider>
    );
  }

  if (phase === "error" || !brands.length) {
    return (
      <StatusScreen
        logo
        title={phase === "error" ? "Workspace unavailable" : "Your account is ready"}
        description={
          phase === "error"
            ? bootError
            : "Finish setting up your workspace to start tracking how AI engines talk about your brand."
        }
      >
        <div className="flex flex-wrap items-center justify-center gap-2">
          {phase === "error" ? (
            <Button onClick={() => window.location.reload()}>Retry</Button>
          ) : (
            <Button nativeButton={false} render={<a href="/onboarding" />}>Set up my workspace</Button>
          )}
          <Button variant="ghost" onClick={signOut}>Sign out</Button>
        </div>
      </StatusScreen>
    );
  }

  return (
    <PortalContext.Provider value={value}>
      <WorkspaceProvider value={{ brandKey, features, isOwner }}>
        <AppShell ready={phase === "ready"} banner={<WorkspaceBanners />}>
          <TopLoadingBar show={overviewLoading && !overview} />
          <PageFrame>{children}</PageFrame>
          <ScanCostReview />
        </AppShell>
      </WorkspaceProvider>
    </PortalContext.Provider>
  );
}

/**
 * The shell's banner slot. The Overview page shows its own error, so the
 * banner appears on the other pages only.
 */
function WorkspaceBanners() {
  const pathname = usePathname() || "/portal";
  const { overviewError, refreshOverview } = usePortal();

  return (
    <>
      <ConsentBanner />
      {overviewError && pathname !== "/portal" ? (
        <AppBanner variant="warning" icon={<AlertTriangle className="size-4" />}>
          <span className="mr-2">Workspace data could not be refreshed. {overviewError}</span>
          <Button size="xs" variant="outline" onClick={refreshOverview}>Try again</Button>
        </AppBanner>
      ) : null}
    </>
  );
}

