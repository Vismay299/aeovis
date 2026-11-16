// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/ShopifyCrawlWarning.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 9 — the Shopify notice that replaces the generic bot-protection
// and rate-limit banners. It never starts an audit: "Run the audit again" is a
// link to the launch page, so a paid re-run still needs a fresh price approval.

import Link from "next/link";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCrawlerAccessList } from "../hooks/useCrawlerAccess";
import { formatAuditDate } from "../shared";

/** A null expiry never expires; the server writes ISO or null. */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= Date.now();
}

/**
 * Shown only for a completed Shopify audit, only while the crawler-access
 * flag is on, and only in place of the four generic bot/rate-limit banners.
 * The credential list is owner-only: a member is never sent to the route and
 * sees the "ask the owner" copy instead.
 */
export function ShopifyCrawlWarning({
  brandKey,
  host,
  isOwner,
  enabled,
}: {
  brandKey: string;
  host: string;
  isOwner: boolean;
  enabled: boolean;
}) {
  const list = useCrawlerAccessList(brandKey, isOwner && enabled);
  if (!enabled) return null;
  // Don't flash the setup steps at an owner who already has a signature.
  if (isOwner && list.isPending) return null;

  const rowsForHost = (list.data?.credentials ?? []).filter(
    (credential) => credential.host === host,
  );
  const live = rowsForHost.find(
    (credential) => !isExpired(credential.expiresAt),
  );
  const expired = rowsForHost.find((credential) =>
    isExpired(credential.expiresAt),
  );

  if (live) {
    return (
      <Alert>
        <ShieldCheck aria-hidden />
        <AlertTitle>{`A crawler signature is saved for ${host}.`}</AlertTitle>
        <div className="col-start-2 space-y-2">
          <p className="text-sm text-muted-foreground">
            {"Run the audit again to crawl with it."}
          </p>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href="/portal/audit" />}
          >
            Run the audit again
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <Alert variant="warning">
      <ShieldAlert aria-hidden />
      <div className="col-start-2 min-w-0 space-y-3">
        <AlertTitle>{"Shopify limited this crawl."}</AlertTitle>
        <p className="text-sm text-muted-foreground">
          {`Shopify rate-limits crawlers it hasn't authorised, so parts of this report are missing. Save a crawler signature, then run the audit again.`}
        </p>
        {expired?.expiresAt ? (
          <p className="text-sm text-muted-foreground">
            {`The saved signature expired on ${formatAuditDate(expired.expiresAt)}.`}
          </p>
        ) : null}
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            {`In Shopify admin, open Online Store → Preferences → Crawler access and create a signature.`}
          </li>
          <li>{`Choose ${host} and an expiry (up to 3 months).`}</li>
          <li>
            {`Paste both values into Shopify crawler access on the audit launch page.`}
          </li>
        </ol>
        {isOwner ? (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href="/portal/audit" />}
          >
            Open crawler access
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {`Ask the workspace owner to save a crawler signature for ${host}.`}
          </p>
        )}
      </div>
    </Alert>
  );
}
