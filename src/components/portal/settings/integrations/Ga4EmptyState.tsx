"use client";

import { Button } from "@/components/ui/button";
import { GoogleGlyph } from "./GoogleGlyph";

/** Not connected yet: an owner connects or chooses a property; a member is told who can. */
export function Ga4EmptyState({ host, canManage, hasGrant, linking, onConnect, onChoose }: {
  host: string;
  canManage: boolean;
  hasGrant: boolean;
  linking: boolean;
  onConnect: () => void;
  onChoose: () => void;
}) {
  if (canManage && hasGrant) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Choose a Google Analytics property to finish connecting this workspace. Choose within 24 hours, or you'll need to connect again.
        </p>
        <Button onClick={onChoose}>Choose property</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Connect Google Analytics to see organic traffic and conversions for {host}.
      </p>
      {canManage ? (
        <Button onClick={onConnect} pending={linking} disabled={linking}>
          {linking ? null : <GoogleGlyph />}
          {linking ? "Opening Google…" : "Connect"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">Only the workspace owner can connect Google Analytics.</p>
      )}
    </div>
  );
}
