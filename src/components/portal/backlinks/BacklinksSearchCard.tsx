"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksSearchCard.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect, useState, type FormEvent } from "react";
import { ResearchScopeSelect } from "@/components/app/ResearchScopeSelect";
import { SearchInput } from "@/components/app/SearchCard";
import { Card, CardContent } from "@/components/ui/card";
import { PricedActionButton } from "@/components/app/cost/PricedActionButton";
import {
  defaultScopeForInput,
  parseResearchTarget,
  type ResearchScope,
} from "@/shared/researchScope";
import { BacklinksQuickPicks } from "./BacklinksQuickPicks";

type SearchDraft = {
  target: string;
  scope: ResearchScope;
};

export function BacklinksSearchCard({
  brandKey,
  initialValues,
  onSubmit,
  pending = false,
}: {
  brandKey: string;
  initialValues: SearchDraft;
  onSubmit: (values: SearchDraft, maxUsd?: number) => void;
  pending?: boolean;
}) {
  const [draftTarget, setDraftTarget] = useState(initialValues.target);
  const [draftScope, setDraftScope] = useState<ResearchScope>(
    initialValues.scope,
  );
  const [userSelectedScope, setUserSelectedScope] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftTarget(initialValues.target);
    setDraftScope(initialValues.scope);
    setUserSelectedScope(false);
    setError(null);
  }, [initialValues.target, initialValues.scope]);

  const validate = (): boolean => {
    const trimmed = draftTarget.trim();
    if (!trimmed) {
      setError("Enter a domain or URL to analyze.");
      return false;
    }
    const parsed = parseResearchTarget(trimmed, draftScope);
    if (!parsed.ok) {
      setError(parsed.message);
      return false;
    }
    setError(null);
    return true;
  };

  const handleSubmit = (maxUsd?: number) => {
    if (!validate()) return;
    onSubmit(
      { target: draftTarget.trim(), scope: draftScope },
      maxUsd,
    );
  };

  return (
    <Card>
      <CardContent className="space-y-3">
        <form
          noValidate
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <SearchInput
              placeholder="Enter a domain or URL"
              aria-label="Domain or URL"
              value={draftTarget}
              onChange={(e) => {
                const nextTarget = e.target.value;
                setDraftTarget(nextTarget);
                setError(null);
                if (!userSelectedScope) {
                  setDraftScope(defaultScopeForInput(nextTarget));
                }
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "backlinks-target-error" : undefined}
            />

            <ResearchScopeSelect
              value={draftScope}
              onChange={(scope) => {
                setUserSelectedScope(true);
                setDraftScope(scope);
                setError(null);
              }}
            />

            <PricedActionButton
              brandKey={brandKey}
              action="backlinks.lookup.run"
              input={{ target: draftTarget.trim(), scope: draftScope }}
              label="Search"
              pendingLabel="Searching…"
              dialogTitle="Run backlink lookup"
              confirmLabel="Search"
              pending={pending}
              className="px-6"
              onRun={(maxUsd) => handleSubmit(maxUsd)}
            />
          </div>

          <BacklinksQuickPicks
            brandKey={brandKey}
            onSelect={(domain) => {
              setDraftTarget(domain);
              setError(null);
              if (!userSelectedScope) {
                setDraftScope(defaultScopeForInput(domain));
              }
            }}
          />
        </form>

        {error ? (
          <p
            id="backlinks-target-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
