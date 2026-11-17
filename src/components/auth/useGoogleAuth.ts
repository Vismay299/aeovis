"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/auth/useGoogleAuth.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState } from "react";
import { getSupabaseBrowserClient } from "../../shared/supabase/browser.js";
import { authCallbackUrl } from "../../shared/auth-redirect.ts";
import { trackAuthEvent } from "./telemetry.ts";

export function buildGoogleOAuthOptions(origin: string, next: string) {
  return {
    provider: "google" as const,
    options: {
      redirectTo: authCallbackUrl(origin, next),
      queryParams: {
        prompt: "select_account",
      },
    },
  };
}

export function useGoogleAuth({
  next,
  intent,
}: {
  next: string;
  intent: "sign_in" | "sign_up";
}) {
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fallbackMessage =
    intent === "sign_up"
      ? "Google sign-up is not available right now."
      : "Google sign-in is not available right now.";

  async function start() {
    setError(null);
    setIsStarting(true);
    trackAuthEvent("auth:google_start", { intent });

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError(fallbackMessage);
      setIsStarting(false);
      return;
    }

    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const oauthOptions = buildGoogleOAuthOptions(origin, next);
      const { error: oauthError } = await supabase.auth.signInWithOAuth(oauthOptions);
      if (oauthError) {
        setError(fallbackMessage);
        setIsStarting(false);
      }
    } catch {
      setError(fallbackMessage);
      setIsStarting(false);
    }
  }

  return {
    isStarting,
    error,
    start,
    clearError: () => setError(null),
  };
}
