"use client";

// F18 phase 9 — the owner-only card that stores a Shopify crawler-access
// signature for the workspace host, and lists the signatures already saved.
// Copy is from features/F18-site-audit.md §6.6.6; the states the spec does not
// define are the PM's PROPOSED copy.

import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CardShell } from "@/components/app/CardShell";
import { QueryError } from "@/components/app/QueryState";
import { describeError } from "@/lib/query/errors";
import {
  useCrawlerAccessList,
  useRemoveCrawlerAccess,
  useSaveCrawlerAccess,
} from "../hooks/useCrawlerAccess";
import { formatAuditDate } from "../shared";

const EMPTY_FIELDS_MESSAGE = "Paste both values from Shopify.";

/**
 * Only an owner and only while `site_audit_crawler_access` is on; the launch
 * view gates both, and the card repeats the flag check so it can never submit
 * to a route that would answer 403.
 */
export function CrawlerAccessCard({
  brandKey,
  host,
  enabled,
}: {
  brandKey: string;
  host: string;
  enabled: boolean;
}) {
  const list = useCrawlerAccessList(brandKey, enabled);
  const save = useSaveCrawlerAccess(brandKey);
  const remove = useRemoveCrawlerAccess(brandKey);
  const [signatureInput, setSignatureInput] = useState("");
  const [signature, setSignature] = useState("");
  const [showEmptyFields, setShowEmptyFields] = useState(false);

  if (!enabled) return null;

  const credentials = list.data?.credentials ?? [];
  const missingSignatureInput = signatureInput.trim() === "";
  const missingSignature = signature.trim() === "";
  const emptyFields =
    showEmptyFields && (missingSignatureInput || missingSignature);

  function submit() {
    if (missingSignatureInput || missingSignature) {
      setShowEmptyFields(true);
      return;
    }
    setShowEmptyFields(false);
    save.mutate(
      { host, signatureInput, signature },
      {
        onSuccess: () => {
          toast.success("Signature saved");
          setSignatureInput("");
          setSignature("");
        },
      },
    );
  }

  return (
    <CardShell title="Shopify crawler access">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {`Shopify limits crawlers it doesn't recognise. Create a crawler signature in Shopify (Online Store → Preferences → Crawler access) for ${host}, then paste both values here.`}
        </p>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="crawler-signature-input">Signature-Input</Label>
            <Input
              id="crawler-signature-input"
              className="font-mono"
              value={signatureInput}
              onChange={(event) => {
                setSignatureInput(event.target.value);
                setShowEmptyFields(false);
              }}
              autoComplete="off"
              spellCheck={false}
              aria-required="true"
              aria-invalid={
                emptyFields && missingSignatureInput ? true : undefined
              }
              aria-describedby={
                emptyFields ? "crawler-signature-error" : undefined
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="crawler-signature">Signature</Label>
            <Textarea
              id="crawler-signature"
              className="font-mono"
              rows={3}
              value={signature}
              onChange={(event) => {
                setSignature(event.target.value);
                setShowEmptyFields(false);
              }}
              autoComplete="off"
              spellCheck={false}
              aria-required="true"
              aria-invalid={emptyFields && missingSignature ? true : undefined}
              aria-describedby={
                emptyFields ? "crawler-signature-error" : undefined
              }
            />
          </div>

          {emptyFields ? (
            <p
              id="crawler-signature-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {EMPTY_FIELDS_MESSAGE}
            </p>
          ) : null}

          {save.error ? (
            <Alert variant="destructive">
              <AlertTitle>{describeError(save.error)}</AlertTitle>
            </Alert>
          ) : null}

          <Button type="submit" pending={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </form>

        <div className="space-y-2 border-t border-border pt-4">
          {list.isPending ? (
            <div
              role="status"
              aria-label="Loading crawler access"
              className="space-y-2"
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : list.isError ? (
            <QueryError
              error={list.error}
              fallback="Couldn't load crawler access."
              onRetry={() => void list.refetch()}
              isRetrying={list.isFetching}
            />
          ) : credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No signature saved for this domain.
            </p>
          ) : (
            <ul className="space-y-2">
              {credentials.map((credential) => {
                const removing =
                  remove.isPending && remove.variables === credential.id;
                return (
                  <li
                    key={credential.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate font-mono text-sm">
                        {credential.host}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {credential.expiresAt
                          ? `Expires ${formatAuditDate(credential.expiresAt)}`
                          : "No expiry"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      pending={removing}
                      disabled={remove.isPending}
                      onClick={() =>
                        remove.mutate(credential.id, {
                          onSuccess: () => toast.success("Signature removed"),
                        })
                      }
                    >
                      {removing ? "Removing…" : "Remove"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {remove.error ? (
            <Alert variant="destructive">
              <AlertTitle>{describeError(remove.error)}</AlertTitle>
            </Alert>
          ) : null}
        </div>
      </div>
    </CardShell>
  );
}
