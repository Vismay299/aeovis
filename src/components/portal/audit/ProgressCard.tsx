// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/AuditDetail.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the progress card shown while an audit is queued or running.

import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { FlipLabel } from "@/components/app/motion/FlipLabel";

export function ProgressCard({
  title,
  badge,
  label,
  percent,
  busy,
  action,
}: {
  title: string;
  badge: string;
  label: string;
  /** 0–100; omit for an indeterminate bar. */
  percent?: number | null;
  busy?: boolean;
  action?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {busy ? <Spinner aria-hidden /> : null}
          {/* Labelled progress: flips only when the audit's phase changes. */}
          <FlipLabel labelKey={title}>{title}</FlipLabel>
          <Badge variant="outline">{badge}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          aria-live="polite"
          className="text-sm text-muted-foreground tabular-nums"
        >
          {label}
        </div>
        <Progress
          value={percent ?? null}
          aria-label={title}
          className="w-full"
        />
        {action ? <div className="pt-1">{action}</div> : null}
      </CardContent>
    </Card>
  );
}
