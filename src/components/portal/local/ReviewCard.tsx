"use client";

import { Badge } from "@/components/ui/badge";
import { Star, MessageSquare, X } from "lucide-react";
import {
  MorphingDialog,
  MorphingDialogClose,
  MorphingDialogContainer,
  MorphingDialogContent,
  MorphingDialogDescription,
  MorphingDialogTitle,
  MorphingDialogTrigger,
} from "@/components/motion-primitives/morphing-dialog";

export type ReviewItem = {
  rank_absolute?: number;
  time_ago?: string;
  timestamp?: string;
  rating?: { value?: number | null };
  review_text?: string | null;
  profile_name?: string | null;
  local_guide?: boolean | null;
  source?: string | null;
  owner_answer?: string | null;
  owner_time_ago?: string | null;
  owner_timestamp?: string | null;
  review_id?: string | null;
};

const PREVIEW_CHARS = 600;
const MORPH = { type: "spring", bounce: 0.12, duration: 0.45 } as const;

function ReviewerName({ review }: { review: ReviewItem }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-foreground">
        {review.profile_name ?? "Google user"}
      </span>
      {review.local_guide && (
        <Badge variant="secondary" className="text-xs">
          Local Guide
        </Badge>
      )}
      {review.source && review.source !== "google" && (
        <Badge variant="outline" className="text-xs capitalize">
          {review.source}
        </Badge>
      )}
    </span>
  );
}

function ReviewRating({ review }: { review: ReviewItem }) {
  const ratingValue = review.rating?.value ?? 0;
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        className="flex items-center text-amber-500"
        aria-label={`${ratingValue} out of 5`}
      >
        {[1, 2, 3, 4, 5].map((s) => (
          <Star
            key={s}
            className={`h-3.5 w-3.5 ${
              s <= ratingValue
                ? "fill-amber-500 text-amber-500"
                : "text-muted-foreground/30"
            }`}
          />
        ))}
      </span>
      {review.time_ago && <span>· {review.time_ago}</span>}
    </span>
  );
}

// Spans with display classes, so the same parts can sit inside the card's
// button (phrasing content only) and in the opened dialog.
function OwnerReply({ review }: { review: ReviewItem }) {
  return review.owner_answer ? (
    <span className="block rounded-md bg-muted/50 p-3 text-xs space-y-1 border-l-2 border-primary ml-2 text-left">
      <span className="flex items-center justify-between text-muted-foreground">
        <span className="font-semibold text-foreground flex items-center gap-1.5">
          <MessageSquare className="h-3 w-3" />
          Response from the owner
        </span>
        {review.owner_time_ago && <span>{review.owner_time_ago}</span>}
      </span>
      <span className="block text-foreground whitespace-pre-wrap">
        {review.owner_answer}
      </span>
    </span>
  ) : (
    <span className="block pt-1">
      <Badge
        variant="outline"
        className="text-xs text-muted-foreground font-normal"
      >
        No reply
      </Badge>
    </span>
  );
}

/**
 * One collected review. A long review shows its first 600 characters; the
 * card itself opens into the whole review (T7 morphing dialog), in place of
 * the old in-card "Show more" toggle. Short reviews are plain cards.
 */
export function ReviewCard({ review }: { review: ReviewItem }) {
  const text = review.review_text ?? "";
  const isLong = text.length > PREVIEW_CHARS;

  if (!isLong) {
    return (
      <div
        className="rounded-lg border border-border bg-card p-4 space-y-3"
        data-slot="review-card"
      >
        <div className="space-y-1">
          <ReviewerName review={review} />
          <ReviewRating review={review} />
        </div>
        {text && (
          <div className="text-sm text-foreground space-y-1">
            <p className="whitespace-pre-wrap">{text}</p>
          </div>
        )}
        <OwnerReply review={review} />
      </div>
    );
  }

  const name = review.profile_name ?? "Google user";

  return (
    <div data-slot="review-card">
      <MorphingDialog transition={MORPH}>
        <MorphingDialogTrigger
          aria-label={`Show the full review by ${name}`}
          className="block w-full rounded-lg border border-border bg-card p-4 text-left space-y-3 outline-none transition-colors hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="block space-y-1">
            <ReviewerName review={review} />
            <ReviewRating review={review} />
          </span>
          <span className="block text-sm text-foreground space-y-1">
            <span className="block whitespace-pre-wrap">{`${text.slice(0, PREVIEW_CHARS)}…`}</span>
            <span className="block text-xs font-medium text-primary">
              Show more
            </span>
          </span>
          <OwnerReply review={review} />
        </MorphingDialogTrigger>
        <MorphingDialogContainer>
          <MorphingDialogContent className="relative m-4 flex max-h-[85dvh] w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg">
            <div className="space-y-1 pr-8">
              <MorphingDialogTitle>
                <ReviewerName review={review} />
              </MorphingDialogTitle>
              <ReviewRating review={review} />
            </div>
            <MorphingDialogDescription
              disableLayoutAnimation
              className="space-y-3"
              variants={{
                initial: { opacity: 0, y: 8 },
                animate: { opacity: 1, y: 0 },
                exit: { opacity: 0, y: 8 },
              }}
            >
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {text}
              </p>
              <OwnerReply review={review} />
            </MorphingDialogDescription>
            <MorphingDialogClose className="top-4 right-4 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none">
              <X aria-hidden className="size-4" />
            </MorphingDialogClose>
          </MorphingDialogContent>
        </MorphingDialogContainer>
      </MorphingDialog>
    </div>
  );
}
