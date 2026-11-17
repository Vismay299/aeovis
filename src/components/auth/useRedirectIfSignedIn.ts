"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../shared/supabase/browser.js";
import { DEFAULT_AFTER_SIGN_IN, normalizeAuthRedirect } from "../../shared/auth-redirect.ts";

export function useRedirectIfSignedIn(next?: string | null) {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const destination = normalizeAuthRedirect(next, DEFAULT_AFTER_SIGN_IN);
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setChecking(false);
      return;
    }

    supabase.auth
      .getUser()
      .then((res: { data?: { user?: { email_confirmed_at?: string | null } | null }; error?: unknown }) => {
        if (cancelled) return;
        const user = res?.data?.user;
        if (!res?.error && user && user.email_confirmed_at) {
          window.location.replace(destination);
          return;
        }
        setChecking(false);
      })
      .catch(() => {
        if (!cancelled) {
          setChecking(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [next]);

  return { checking };
}
