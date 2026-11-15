// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/AddKeywordsPanel.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CostReviewDialog } from "@/components/app/cost/CostReviewDialog";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import type { PriceQuote } from "@/shared/pricing";
import { MAX_TRACKED_KEYWORD_LENGTH, devicesLabel } from "@/shared/rank-tracking";
import { trackRankEvent, buildKeywordsAddPayload } from "./telemetry";
import type { RankTrackerSummary } from "./hooks/useRankTrackers";

function isApiError(err: unknown): err is { code?: string; message?: string; details?: unknown } {
  return typeof err === "object" && err !== null && "code" in err;
}

export function AddKeywordsPanel({
  brandKey,
  config,
  onSuccess,
  onCancel,
}: {
  brandKey: string;
  config: RankTrackerSummary;
  onSuccess: (result: { added: number }) => void;
  onCancel: () => void;
}) {
  const matchCaseId = useId();
  const [keywordInput, setKeywordInput] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [approval, setApproval] = useState<{
    approvedMaxUsd: number;
    quote: PriceQuote;
  } | null>(null);

  const parsedLines = keywordInput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  async function handleAddKeywords(maxUsd?: number) {
    if (parsedLines.length === 0) return;
    if (parsedLines.some((l) => l.length > MAX_TRACKED_KEYWORD_LENGTH)) {
      toast.error(`Keywords must be ${MAX_TRACKED_KEYWORD_LENGTH} characters or fewer.`);
      return;
    }
    setIsPending(true);
    try {
      const result = await fetchJson<{
        added: number;
        addedIds: string[];
        skipped: number;
        metricsFromCache: number;
        approval?: { approvedMaxUsd: number; quote: PriceQuote };
      }>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(config.id)}/keywords`,
          brandKey,
        ),
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            keywords: parsedLines,
            matchCase,
            maxUsd,
          },
        },
      );

      trackRankEvent(
        "rank_tracking:keywords_add",
        buildKeywordsAddPayload({ count: result.added, source: "manual" }),
      );
      setApproval(null);
      onSuccess({ added: result.added });
    } catch (err: unknown) {
      if (isApiError(err) && err.code === "approval_required" && err.details) {
        const details = err.details as { quote: PriceQuote };
        setApproval({
          approvedMaxUsd: details.quote.totalUsd,
          quote: details.quote,
        });
        return;
      }
      toast.error(
        isApiError(err) && err.message
          ? err.message
          : "Failed to add keywords. Please try again.",
      );
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="space-y-2">
        <Textarea
          rows={5}
          aria-label="Keywords to add"
          placeholder="One keyword per line"
          value={keywordInput}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            setKeywordInput(e.target.value)
          }
        />
        <div className="flex w-fit items-center gap-2">
          <Checkbox
            id={matchCaseId}
            checked={matchCase}
            onCheckedChange={(checked: boolean | "indeterminate") =>
              setMatchCase(Boolean(checked))
            }
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Label htmlFor={matchCaseId} className="text-xs font-normal cursor-help">
                  Match case
                </Label>
              }
            >
              Match case
            </TooltipTrigger>
            <TooltipContent>
              Track these keywords exactly as typed instead of lowercasing them. Google can return different results for a capitalized brand name.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={isPending || parsedLines.length === 0}
          onClick={() => void handleAddKeywords()}
        >
          {isPending ? "Adding…" : "Add Keywords"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      </div>

      {approval && (
        <CostReviewDialog
          open={Boolean(approval)}
          title="Approve scheduled checks"
          confirmLabel="Approve and save"
          pendingLabel="Saving…"
          quote={{ data: approval.quote }}
          pending={isPending}
          priceChanged={null}
          error={null}
          onConfirm={(maxUsd) => void handleAddKeywords(maxUsd)}
          onClose={() => setApproval(null)}
          detail={() => (
            <p className="text-sm text-muted-foreground">
              {parsedLines.length} keywords on {devicesLabel(config.devices)}, checked {config.scheduleInterval}
            </p>
          )}
        />
      )}
    </div>
  );
}
