"use client";

// Portions copied from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/auth/TurnstileWidget.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useEffect, useRef, useState } from "react";

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

type TurnstileApi = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      size: "compact";
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    }
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * Captcha state for a form: the token in a ref (read at submit time, so the
 * form's submit closure never sees a stale value), a boolean mirror to drive
 * the submit button, and a reset (tokens are single-use — re-challenge after a
 * failed submit). Wire `onToken`/`resetNonce` into <TurnstileWidget />.
 */
export function useTurnstileCaptcha() {
  const tokenRef = useRef<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);

  const onToken = useCallback((token: string | null) => {
    tokenRef.current = token;
    setHasToken(Boolean(token));
  }, []);

  const reset = useCallback(() => {
    tokenRef.current = null;
    setHasToken(false);
    setResetNonce((nonce) => nonce + 1);
  }, []);

  return { tokenRef, hasToken, resetNonce, onToken, reset };
}

/**
 * Renders the Cloudflare Turnstile challenge and reports its token.
 * `onToken` fires with the token when solved and with null when it expires/errors.
 * Bump `resetNonce` to re-challenge (tokens are single-use, so reset after a
 * failed submit).
 */
export function TurnstileWidget({
  siteKey,
  onToken,
  resetNonce,
}: {
  siteKey?: string;
  onToken: (token: string | null) => void;
  resetNonce: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [scriptFailed, setScriptFailed] = useState(false);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;

    const renderWidget = () => {
      if (
        cancelled ||
        widgetIdRef.current !== null ||
        !containerRef.current ||
        !window.turnstile
      ) {
        return;
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        size: "compact",
        callback: (token) => onTokenRef.current(token),
        "expired-callback": () => onTokenRef.current(null),
        "error-callback": () => onTokenRef.current(null),
      });
    };

    if (window.turnstile) {
      renderWidget();
    } else {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${TURNSTILE_SCRIPT_SRC}"]`
      );
      const script = existing ?? document.createElement("script");
      script.addEventListener("load", renderWidget);
      script.addEventListener("error", () => {
        script.remove();
        if (!cancelled) setScriptFailed(true);
      });
      if (!existing) {
        script.src = TURNSTILE_SCRIPT_SRC;
        script.async = true;
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetNonce === 0) return;
    if (widgetIdRef.current !== null && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
      onTokenRef.current(null);
    }
  }, [resetNonce]);

  if (!siteKey) return null;
  if (scriptFailed) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The security check couldn't load. Allow challenges.cloudflare.com in your browser or ad blocker, then reload the page.
      </p>
    );
  }
  return (
    <div
      ref={containerRef}
      aria-label="Security check"
      className="flex justify-center"
    />
  );
}
