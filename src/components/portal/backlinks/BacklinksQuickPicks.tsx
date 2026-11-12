"use client";

import { useWorkspace } from "@/components/app/workspace/WorkspaceContext";
import { useProjectContext } from "@/components/portal/context/hooks/useProjectContext";
import { Button } from "@/components/ui/button";

function extractHostname(urlOrHost: string): string {
  if (!urlOrHost) return "";
  try {
    const url = urlOrHost.includes("://")
      ? new URL(urlOrHost)
      : new URL(`https://${urlOrHost}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return urlOrHost.replace(/^www\./, "");
  }
}

export function BacklinksQuickPicks({
  brandKey,
  onSelect,
}: {
  brandKey: string;
  onSelect: (target: string) => void;
}) {
  const workspace = useWorkspace();
  const isMemoryEnabled = Boolean(workspace?.features?.project_memory);
  const context = useProjectContext(isMemoryEnabled ? brandKey : "");

  if (!isMemoryEnabled || !context.data) {
    return null;
  }

  const website = context.data.brandIdentity?.website;
  const ownHost = website ? extractHostname(website) : "";
  const competitors = context.data.competitors ?? [];

  if (!ownHost && competitors.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
      <span className="font-medium">Quick picks:</span>
      {ownHost ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-6 text-xs"
          onClick={() => onSelect(ownHost)}
        >
          Your site · {ownHost}
        </Button>
      ) : null}
      {competitors.map((comp) => {
        const domain = comp.domain ? extractHostname(comp.domain) : "";
        if (!domain) return null;
        return (
          <Button
            key={comp.id || domain}
            type="button"
            variant="outline"
            size="xs"
            className="h-6 text-xs"
            onClick={() => onSelect(domain)}
          >
            {comp.name ? `${comp.name} (${domain})` : domain}
          </Button>
        );
      })}
    </div>
  );
}
