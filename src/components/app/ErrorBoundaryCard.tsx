"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/DefaultCatchBoundary.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";

export function ErrorBoundaryCard({
  error,
  reset,
}: {
  error: unknown;
  reset?: () => void;
}) {
  // A boundary catches render crashes, whose messages are technical (or, for
  // Server Components in production, Next's generic digest text). Users get
  // the friendly line; the error goes to the console, and to the card only in
  // development.
  useEffect(() => {
    console.error(error);
  }, [error]);
  const detail =
    process.env.NODE_ENV !== "production" &&
    error instanceof Error &&
    error.message
      ? error.message
      : null;

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-2 text-center">
          <p className="text-destructive">
            Something went wrong. Please try again.
          </p>
          {detail ? (
            <p className="font-mono text-xs break-words text-muted-foreground">
              {detail}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-center gap-2">
          {reset ? (
            <Button onClick={reset} size="sm">
              Try again
            </Button>
          ) : null}
          <Button
            onClick={() => window.history.back()}
            size="sm"
            variant="outline"
          >
            Go back
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
