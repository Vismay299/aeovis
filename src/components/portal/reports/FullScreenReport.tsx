// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/reports/$reportId.tsx:300-346
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useRef } from "react";
import { Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReportViewer } from "./ReportViewer.tsx";

// Esc leaves the expanded view. The listener is on the parent window, and the
// expanded body is almost entirely the sandboxed iframe: one click inside
// moves focus into the frame, which has no scripts and so cannot forward the
// key. Focusing Exit on entry keeps Esc working until the reader clicks into
// the report; Exit is the guaranteed path.
export function FullScreenReport({
  reportId,
  title,
  onExit,
}: {
  reportId: string;
  title: string;
  onExit: () => void;
}) {
  const exitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    exitRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onExit();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onExit]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <span className="truncate text-sm font-medium">{title}</span>
        <Button ref={exitRef} variant="ghost" onClick={onExit}>
          <Minimize2 data-icon="inline-start" />
          Exit
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <ReportViewer
          src={`/r/${reportId}`}
          title={title}
          className="h-full w-full bg-background"
        />
      </div>
    </div>
  );
}
