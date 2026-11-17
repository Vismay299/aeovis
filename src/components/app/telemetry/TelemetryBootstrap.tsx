"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/PrivacyChoices.tsx:101-143
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { getSupabaseBrowserClient } from "@/shared/supabase/browser";
import {
  PRIVACY_CHOICES_CHANGED_EVENT,
  effectiveAnalyticsChoice,
  hasGlobalPrivacyControl,
  readPrivacyCookie,
  writePrivacyCookie,
} from "@/shared/privacy-choices";
import {
  startAnalyticsCapture,
  stopAnalyticsCapture,
} from "@/shared/telemetry/client";
import { wireClientSinks } from "./wireClientSinks";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { privacyKeys } from "@/shared/query/keys";
import { fetchJson } from "@/shared/query/fetchJson";
import type { PrivacyChoiceResponse } from "./useAnalyticsConsent";

const ALLOWED_SURFACES = [
  "/portal",
  "/onboarding",
  "/login",
  "/signup",
  "/auth",
] as const;

function isAllowedSurface(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return ALLOWED_SURFACES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

function subscribeToPrivacyCookie(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PRIVACY_CHOICES_CHANGED_EVENT, onChange);
  window.addEventListener("focus", onChange);
  return () => {
    window.removeEventListener(PRIVACY_CHOICES_CHANGED_EVENT, onChange);
    window.removeEventListener("focus", onChange);
  };
}

const readCookies = () => (typeof document !== "undefined" ? document.cookie : "");

export function TelemetryBootstrap() {
  const pathname = usePathname();
  const queryClient = useQueryClient();

  useEffect(() => {
    wireClientSinks();
  }, []);

  const cookieStr = useSyncExternalStore(
    subscribeToPrivacyCookie,
    readCookies,
    () => "",
  );
  const cookieVal = useMemo(() => readPrivacyCookie(cookieStr), [cookieStr]);

  const [sessionState, setSessionState] = useState<{
    signedIn: boolean;
    userId: string | null;
  }>({
    signedIn: false,
    userId: null,
  });

  const privacyQuery = useQuery({
    queryKey: privacyKeys.choice(),
    queryFn: () => fetchJson<PrivacyChoiceResponse>("/api/customer/privacy"),
    enabled: sessionState.signedIn,
    staleTime: 60_000,
  });

  const accountChoice = sessionState.signedIn
    ? (privacyQuery.data?.analytics ?? null)
    : null;

  useEffect(() => {
    function handlePrivacyChange() {
      if (sessionState.signedIn) {
        void queryClient.invalidateQueries({ queryKey: privacyKeys.choice() });
      }
    }
    window.addEventListener(PRIVACY_CHOICES_CHANGED_EVENT, handlePrivacyChange);
    return () => {
      window.removeEventListener(PRIVACY_CHOICES_CHANGED_EVENT, handlePrivacyChange);
    };
  }, [queryClient, sessionState.signedIn]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    let active = true;

    async function checkSession() {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!active) return;
        const signedIn = Boolean(session?.user);
        const userId = session?.user?.id ?? null;
        setSessionState({ signedIn, userId });
      } catch {
        // network or server error: treat as undecided
      }
    }

    void checkSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void checkSession();
    });

    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [pathname]);

  useEffect(() => {
    if (!isAllowedSurface(pathname)) {
      // Client-side navigation can leave the app (e.g. the banner's /privacy
      // link); the public site stays untracked, so stop capture there.
      stopAnalyticsCapture();
      return;
    }

    const choice = effectiveAnalyticsChoice({
      account: accountChoice,
      cookie: cookieVal,
      signedIn: sessionState.signedIn,
      gpc: hasGlobalPrivacyControl(),
    });

    if (choice) {
      startAnalyticsCapture();
    } else {
      stopAnalyticsCapture();
    }

    if (
      sessionState.signedIn &&
      accountChoice !== null &&
      cookieVal !== accountChoice
    ) {
      writePrivacyCookie(accountChoice);
    }
  }, [pathname, accountChoice, cookieVal, sessionState.signedIn]);

  return null;
}
