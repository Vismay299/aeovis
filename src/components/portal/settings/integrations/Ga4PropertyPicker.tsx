// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/integrations/GooglePropertyPicker.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/app/QueryState";
import { cn } from "@/lib/utils";
import { numericPropertyId } from "./Ga4ConnectedState";
import type { Ga4PickerAccount } from "./hooks/useGa4Properties";

export type Ga4Selection = { grantId: string; propertyId: string };

const SEARCH_THRESHOLD = 8;

function accountLabel(account: Ga4PickerAccount) {
  return account.email ?? `Google account · ${account.grantId.slice(-6)}`;
}

/** One section per linked Google account; the owner picks one property and saves it. */
export function Ga4PropertyPicker({ accounts, loading, error, selection, onSelect, onSave, saving, onCancel, onRetry, onLink, linking }: {
  accounts: Ga4PickerAccount[];
  loading: boolean;
  error: unknown;
  selection: Ga4Selection | null;
  onSelect: (selection: Ga4Selection) => void;
  onSave: () => void;
  saving: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onLink: () => void;
  linking: boolean;
}) {
  const [search, setSearch] = useState("");
  const total = accounts.reduce((sum, account) => sum + account.properties.length, 0);
  const query = search.trim().toLowerCase();
  const selectedAccount = accounts.find((account) => account.grantId === selection?.grantId);
  const canSave = Boolean(
    selectedAccount &&
      !selectedAccount.requiresReconnect &&
      !selectedAccount.propertiesUnavailable &&
      selectedAccount.properties.some((property) => property.propertyId === selection?.propertyId),
  );

  return (
    <div className="space-y-4">
      {total > SEARCH_THRESHOLD ? (
        <label className="flex items-center gap-2 rounded-md border border-input px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Search properties"
            placeholder="Search properties"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </label>
      ) : null}

      {loading ? (
        <div role="status" aria-label="Loading properties" className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error ? (
        <QueryError error={error} fallback="Couldn't load your Google Analytics properties." onRetry={onRetry} />
      ) : (
        <div className="max-h-96 space-y-4 overflow-y-auto overscroll-contain pr-1">
          {accounts.map((account) => {
            const properties = account.properties.filter((property) =>
              !query || `${property.displayName} ${property.accountDisplayName} ${property.propertyId}`.toLowerCase().includes(query),
            );
            return (
              <section key={account.grantId} aria-label={accountLabel(account)} className="space-y-1">
                <p className="break-all text-xs font-medium text-muted-foreground">{accountLabel(account)}</p>
                {account.requiresReconnect ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">This Google account needs to be reconnected.</span>
                    <Button size="sm" variant="outline" onClick={onLink} disabled={linking}>Reconnect</Button>
                  </div>
                ) : account.propertiesUnavailable ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">Couldn't load properties for this account.</span>
                    <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
                  </div>
                ) : account.properties.length === 0 ? (
                  <p className="text-sm text-muted-foreground">This Google account can't read any Google Analytics properties.</p>
                ) : (
                  <ul className="space-y-1">
                    {properties.map((property) => {
                      const chosen = selection?.grantId === account.grantId && selection.propertyId === property.propertyId;
                      return (
                        <li key={property.propertyId}>
                          <button
                            type="button"
                            aria-pressed={chosen}
                            disabled={saving}
                            onClick={() => onSelect({ grantId: account.grantId, propertyId: property.propertyId })}
                            className={cn(
                              "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50",
                              chosen && "bg-accent",
                            )}
                          >
                            <span className="min-w-0">
                              <span className="block break-words">{property.displayName}</span>
                              <span className="block text-xs text-muted-foreground">
                                {property.accountDisplayName} · {numericPropertyId(property.propertyId)}
                              </span>
                            </span>
                            {chosen ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onLink} disabled={saving || linking} pending={linking}>
          {linking ? "Opening Google…" : "Add another Google account"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button onClick={onSave} disabled={!canSave || saving} pending={saving}>
          {saving ? "Saving…" : "Save property"}
        </Button>
      </div>
    </div>
  );
}
