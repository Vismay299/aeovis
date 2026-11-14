"use client";

import { useEffect } from "react";
import { ErrorBoundaryCard } from "@/components/app/ErrorBoundaryCard";
import { captureClientError } from "@/lib/telemetry/client";

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // F26: report client errors with type/code/stack only (never content).
  // No stale-chunk reload path exists in the tree, and ChunkLoadError is
  // already in the client ignorable list, so no stopClientErrorCapture call.
  useEffect(() => {
    captureClientError(error, { boundary: "portal" });
  }, [error]);
  return <ErrorBoundaryCard error={error} reset={reset} />;
}
