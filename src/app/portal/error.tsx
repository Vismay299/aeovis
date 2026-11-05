"use client";

import { ErrorBoundaryCard } from "@/components/app/ErrorBoundaryCard";

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundaryCard error={error} reset={reset} />;
}
