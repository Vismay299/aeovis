"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { CardShell } from "@/components/app/CardShell";
import { QueryError } from "@/components/app/QueryState";
import { RowActionsMenu } from "@/components/app/RowActionsMenu";
import { describeError } from "@/shared/query/errors";
import { GoogleAccountRemovalDialog } from "./GoogleAccountRemovalDialog";
import { useGa4Accounts, useRemoveGa4Account, type Ga4LinkedAccount } from "./hooks/useGa4Accounts";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The caller's own linked Google accounts; removing one disconnects every workspace using it. */
export function GoogleAccountsCard({ brandKey }: { brandKey: string }) {
  const accounts = useGa4Accounts(brandKey);
  const remove = useRemoveGa4Account(brandKey);
  const [removing, setRemoving] = useState<Ga4LinkedAccount | null>(null);
  const rows = accounts.data?.accounts ?? [];
  const current = removing ? rows.find((row) => row.grantId === removing.grantId) ?? null : null;

  return (
    <CardShell title="Your linked Google accounts">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Google accounts you linked for Google Analytics. Removing one disconnects every workspace that uses it.
        </p>
        {accounts.isPending ? (
          <div role="status" aria-label="Loading linked accounts" className="space-y-2">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : accounts.isError && !accounts.data ? (
          <QueryError error={accounts.error} fallback="Couldn't load your linked Google accounts." onRetry={() => void accounts.refetch()} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">You haven't linked a Google account.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.grantId} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="break-all text-sm font-medium">{row.email ?? `Google account · ${row.grantId.slice(-6)}`}</p>
                  <p className="text-xs text-muted-foreground">
                    Linked {dateFormat.format(new Date(row.linkedAt))} · Used by {row.workspaces} workspace{row.workspaces === 1 ? "" : "s"}
                  </p>
                  {row.status === "error" ? <Badge variant="warning">Needs reconnecting</Badge> : null}
                </div>
                <RowActionsMenu label={`Actions for ${row.email ?? "Google account"}`}>
                  <DropdownMenuItem variant="destructive" onClick={() => { remove.reset(); setRemoving(row); void accounts.refetch(); }}>
                    Remove
                  </DropdownMenuItem>
                </RowActionsMenu>
              </li>
            ))}
          </ul>
        )}
      </div>
      {removing ? (
        <GoogleAccountRemovalDialog
          account={removing}
          impact={{
            loading: accounts.isFetching,
            failed: accounts.isError,
            workspaces: current ? current.workspaces : null,
            retry: () => void accounts.refetch(),
          }}
          removing={remove.isPending}
          error={remove.error ? describeError(remove.error) : null}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            remove.mutate(removing.grantId, {
              onSuccess: () => {
                toast.success("Google account removed");
                setRemoving(null);
              },
            })
          }
        />
      ) : null}
    </CardShell>
  );
}
