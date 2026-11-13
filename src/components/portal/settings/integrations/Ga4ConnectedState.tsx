"use client";

import { Button } from "@/components/ui/button";
import type { Ga4ConnectionState } from "./hooks/useGa4Connection";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export function numericPropertyId(propertyId: string): string {
  return propertyId.replace(/^properties\//, "");
}

/** The saved property, who connected it and when; owners can change or disconnect it. */
export function Ga4ConnectedState({ state, onChange, onDisconnect, disconnecting }: {
  state: Ga4ConnectionState;
  onChange: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
}) {
  const property = state.property;
  if (!property) return null;
  const connectedOn = state.connectedAt ? dateFormat.format(new Date(state.connectedAt)) : null;
  const byline = [state.connectedByEmail, connectedOn ? `connected ${connectedOn}` : null].filter(Boolean).join(" · ");
  return (
    <div className="space-y-3">
      <div className="min-w-0">
        <p className="break-words font-semibold">{property.displayName}</p>
        <p className="text-sm text-muted-foreground">ID {numericPropertyId(property.id)}</p>
        {byline ? <p className="break-all text-sm text-muted-foreground">{byline}</p> : null}
      </div>
      {state.canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onChange} disabled={disconnecting}>Change property or account</Button>
          <Button variant="destructive" onClick={onDisconnect} pending={disconnecting} disabled={disconnecting}>
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
