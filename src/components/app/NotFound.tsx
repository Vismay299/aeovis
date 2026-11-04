"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/NotFound.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function NotFound() {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>404</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground">
          The page you are looking for does not exist.
        </CardContent>
        <CardFooter>
          <Button nativeButton={false} render={<Link href="/portal" />}>
            Back to overview
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
