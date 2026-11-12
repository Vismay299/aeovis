"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Star, MessageSquare } from "lucide-react";

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

export function ReviewCard({ review }: { review: ReviewItem }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const ratingValue = review.rating?.value ?? 0;
  const text = review.review_text ?? "";
  const isLong = text.length > 600;
  const displayText = isLong && !isExpanded ? `${text.slice(0, 600)}…` : text;

  return (
    <div
      className="rounded-lg border border-border bg-card p-4 space-y-3"
      data-slot="review-card"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div
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
            </div>
            {review.time_ago && <span>· {review.time_ago}</span>}
          </div>
        </div>
      </div>

      {text && (
        <div className="text-sm text-foreground space-y-1">
          <p className="whitespace-pre-wrap">{displayText}</p>
          {isLong && (
            <Button
              variant="link"
              size="sm"
              className="p-0 h-auto text-xs text-primary"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? "Show less" : "Show more"}
            </Button>
          )}
        </div>
      )}

      {review.owner_answer ? (
        <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1 border-l-2 border-primary ml-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="font-semibold text-foreground flex items-center gap-1.5">
              <MessageSquare className="h-3 w-3" />
              Response from the owner
            </span>
            {review.owner_time_ago && <span>{review.owner_time_ago}</span>}
          </div>
          <p className="text-foreground whitespace-pre-wrap">
            {review.owner_answer}
          </p>
        </div>
      ) : (
        <div className="pt-1">
          <Badge variant="outline" className="text-xs text-muted-foreground font-normal">
            No reply
          </Badge>
        </div>
      )}
    </div>
  );
}
