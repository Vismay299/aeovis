// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/integrations/GoogleConnectionCard.tsx:31-281
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CardShell } from "@/components/app/CardShell";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { QueryError } from "@/components/app/QueryState";
import { describeError } from "@/lib/query/errors";
import { usePortal } from "@/components/portal/PortalShell";
import { Ga4ConnectedState } from "./Ga4ConnectedState";
import { Ga4EmptyState } from "./Ga4EmptyState";
import { Ga4LinkErrorAlert } from "./Ga4LinkErrorAlert";
import { Ga4PropertyPicker, type Ga4Selection } from "./Ga4PropertyPicker";
import { GoogleAnalyticsLogo } from "./GoogleProductLogos";
import { useDisconnectGa4, useGa4Connection, useSetGa4Property } from "./hooks/useGa4Connection";
import { useGa4Properties } from "./hooks/useGa4Properties";
import { useStartGa4Link } from "./hooks/useStartGa4Link";

function hostOf(website: string | undefined): string {
  if (!website) return "your website";
  try {
    return new URL(/^https?:\/\//.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, "");
  } catch {
    return website;
  }
}

/**
 * Connects one workspace to Google Analytics. Props are frozen: F27 renders
 * this card in onboarding.
 */
export function Ga4ConnectionCard({ brandKey, returnTo, onConnectClick }: {
  brandKey: string;
  /** Path the OAuth callback returns to; must start with "/portal/". */
  returnTo: string;
  /** Called before redirecting to Google, for telemetry. */
  onConnectClick?: () => void;
}) {
  const { brand } = usePortal();
  const connection = useGa4Connection(brandKey);
  const state = connection.data;
  const [picking, setPicking] = useState(false);
  const [selection, setSelection] = useState<Ga4Selection | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const startLink = useStartGa4Link(brandKey, returnTo);
  const setProperty = useSetGa4Property(brandKey);
  const disconnect = useDisconnectGa4(brandKey);

  const canManage = state?.canManage === true;
  const connected = state?.connected === true;
  const needsSetup = state ? !state.configured : false;
  const showPicker = canManage && picking;
  const properties = useGa4Properties(brandKey, canManage && picking);

  // Preselect the saved property when the owner reopens the picker.
  useEffect(() => {
    if (!picking || selection || !properties.data) return;
    for (const account of properties.data.accounts) {
      const saved = account.properties.find((property) => property.isSelected);
      if (saved) {
        setSelection({ grantId: account.grantId, propertyId: saved.propertyId });
        return;
      }
    }
  }, [picking, selection, properties.data]);

  const link = () => {
    onConnectClick?.();
    startLink.mutate();
  };
  const openPicker = () => {
    setProperty.reset();
    setSelection(null);
    setPicking(true);
  };
  const save = () => {
    if (!selection) return;
    setProperty.mutate(selection, {
      onSuccess: () => {
        toast.success("Google Analytics connected");
        setPicking(false);
        setSelection(null);
      },
    });
  };

  const reconnectReason = connected && state
    ? !state.connectorIsMember
      ? "The person who connected Google Analytics is no longer in this workspace. Reconnect it to keep seeing data."
      : state.grantStatus === "error"
        ? "The Google Analytics connection has expired or was revoked."
        : null
    : null;

  const pill = !state ? null : needsSetup ? (
    <Badge variant="warning">Setup required</Badge>
  ) : connected && !reconnectReason ? (
    <Badge variant="success">Connected</Badge>
  ) : (
    <Badge variant="outline">Not connected</Badge>
  );

  const mutationError = setProperty.error ?? disconnect.error ?? startLink.error;

  return (
    <section id="google-analytics">
      <CardShell title="Google Analytics" icon={<GoogleAnalyticsLogo />} action={pill}>
        <div className="space-y-4">
          <Ga4LinkErrorAlert />
          {connection.isPending ? (
            <div role="status" aria-label="Loading connection" className="space-y-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-9 w-24" />
            </div>
          ) : connection.isError && !state ? (
            <QueryError
              error={connection.error}
              fallback="Couldn't check this workspace's Google Analytics connection."
              onRetry={() => void connection.refetch()}
              isRetrying={connection.isFetching}
            />
          ) : !state ? null : needsSetup ? (
            <Alert variant="warning">
              <AlertDescription>Google Analytics isn't set up on this deployment yet.</AlertDescription>
            </Alert>
          ) : showPicker ? (
            <Ga4PropertyPicker
              accounts={properties.data?.accounts ?? []}
              loading={properties.isPending}
              error={properties.isError ? properties.error : null}
              selection={selection}
              onSelect={setSelection}
              onSave={save}
              saving={setProperty.isPending}
              onCancel={() => { setPicking(false); setSelection(null); setProperty.reset(); }}
              onRetry={() => void properties.refetch()}
              onLink={link}
              linking={startLink.isPending || startLink.isSuccess}
            />
          ) : connected ? (
            <>
              {reconnectReason ? (
                <Alert variant="warning">
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                    <span>{reconnectReason}</span>
                    {canManage ? <Button size="sm" variant="outline" onClick={link} pending={startLink.isPending}>Reconnect</Button> : null}
                  </AlertDescription>
                </Alert>
              ) : null}
              <Ga4ConnectedState
                state={state}
                onChange={openPicker}
                onDisconnect={() => setConfirmDisconnect(true)}
                disconnecting={disconnect.isPending}
              />
            </>
          ) : (
            <Ga4EmptyState
              host={hostOf(brand?.website)}
              canManage={canManage}
              hasGrant={state.currentUserHasGrant}
              linking={startLink.isPending || startLink.isSuccess}
              onConnect={link}
              onChoose={openPicker}
            />
          )}
          {mutationError ? <p role="alert" className="text-sm text-destructive">{describeError(mutationError)}</p> : null}
        </div>
      </CardShell>
      {confirmDisconnect ? (
        <ConfirmDialog
          title="Disconnect Google Analytics?"
          confirmLabel="Disconnect"
          destructive
          pending={disconnect.isPending}
          onClose={() => setConfirmDisconnect(false)}
          onConfirm={() =>
            disconnect.mutate(undefined, {
              onSuccess: () => {
                toast.success("Google Analytics disconnected from this workspace");
                setConfirmDisconnect(false);
              },
            })
          }
        >
          This workspace stops showing Analytics data and its cached reports are deleted. Your Google account stays linked to Perceev until you remove it below.
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
