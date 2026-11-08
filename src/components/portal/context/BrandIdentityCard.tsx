"use client";

import { CardShell } from "@/components/app/CardShell";
import { Badge } from "@/components/ui/badge";

export function BrandIdentityCard({
  brandIdentity,
}: {
  brandIdentity: {
    displayName: string;
    website: string;
    matchNames: string[];
  };
}) {
  return (
    <CardShell title="Names we look for in AI answers">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5" aria-label="Brand match names">
          {brandIdentity.matchNames.map((name) => (
            <Badge key={name} variant="secondary">
              {name}
            </Badge>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Website: {brandIdentity.website}. To change these names, contact Perceev support.
        </p>
      </div>
    </CardShell>
  );
}
