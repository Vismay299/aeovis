// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/integrations/googleAuthErrorCopy.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { GA4_LINK_ERROR_PARAM, ga4AuthErrorCopy } from "@/shared/ga4";

/**
 * Shows the error the OAuth callback sent back in `?ga4_error=`, then removes
 * the parameter so a reload or a shared link does not show it again.
 */
export function Ga4LinkErrorAlert({ className }: { className?: string }) {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const value = url.searchParams.get(GA4_LINK_ERROR_PARAM);
    if (!value) return;
    setCode(value);
    url.searchParams.delete(GA4_LINK_ERROR_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  if (!code) return null;
  const copy = ga4AuthErrorCopy(code);
  return (
    <Alert variant="destructive" className={className}>
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.description}</AlertDescription>
    </Alert>
  );
}
