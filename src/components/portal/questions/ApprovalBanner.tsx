"use client";

import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/components/portal/ui";
import type { QuestionsState } from "./hooks/useQuestions";

export function ApprovalBanner({
  state,
  onApprove,
}: {
  state: QuestionsState;
  onApprove: () => void;
}) {
  const approved = state.approved;
  const diff = state.diff;
  if (!approved) {
    return (
      <Alert>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>No approved questions yet. Scans start only after you approve.</span>
          <Button size="sm" onClick={onApprove}>Approve questions</Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (diff.dirty) {
    const parts = [`${diff.added} added`, `${diff.removed} removed`];
    if (diff.contextChanged) parts.push("audience or market changed");
    return (
      <Alert variant="warning">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Scans keep asking version {approved.version} until you approve these changes: {parts.join(", ")}.
          </span>
          <Button size="sm" onClick={onApprove}>Approve changes</Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Badge variant="success">Approved · version {approved.version}</Badge>
        <span className="text-sm text-muted-foreground">Approved {formatRelative(approved.approvedAt)}</span>
      </div>
      {approved.carriesQuestionIds === false ? (
        <p className="text-sm text-muted-foreground">
          Version {approved.version} was approved before question tracking. Approve again to link history to each question.
        </p>
      ) : null}
    </div>
  );
}
