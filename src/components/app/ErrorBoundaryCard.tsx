"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/DefaultCatchBoundary.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describeError } from "@/components/app/errors/describeError";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";

export function ErrorBoundaryCard({
  error,
  reset,
}: {
  error: unknown;
  reset?: () => void;
}) {
  const message = describeError(
    error,
    "Something went wrong. Please try again."
  );

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="text-center text-destructive">
          {message}
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
