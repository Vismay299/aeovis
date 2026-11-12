"use client";

import { Button } from "@/components/ui/button";
import type { ResearchScope } from "@/shared/researchScope";

type Competitor = {
  domain: string;
  name?: string | null;
};

type Props = {
  available: boolean;
  ownHost?: string;
  competitors: Competitor[];
  onPick: (domain: string, scope: ResearchScope) => void;
};

export function DomainQuickPicks({
  available,
  ownHost,
  competitors,
  onPick,
}: Props) {
  if (!available) return null;
  if (!ownHost && competitors.length === 0) return null;

  const visibleCompetitors = competitors.slice(0, 8);
  const remainingCount = competitors.length - visibleCompetitors.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Quick picks:</span>
      {ownHost ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-6 rounded-full px-2.5 text-xs font-normal"
          onClick={() => onPick(ownHost, "subdomains")}
        >
          Your site · {ownHost}
        </Button>
      ) : null}
      {visibleCompetitors.map((comp) => (
        <Button
          key={comp.domain}
          type="button"
          variant="outline"
          size="xs"
          className="h-6 rounded-full px-2.5 text-xs font-normal"
          onClick={() => onPick(comp.domain, "subdomains")}
        >
          {comp.name ? `${comp.name} (${comp.domain})` : comp.domain}
        </Button>
      ))}
      {remainingCount > 0 ? (
        <span className="text-xs text-muted-foreground">
          +{remainingCount} more
        </span>
      ) : null}
    </div>
  );
}
