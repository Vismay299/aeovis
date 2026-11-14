"use client";

// F19 phase 4 — post-publish IndexNow offer in Content Studio.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/components/app/workspace/WorkspaceContext";
import { useIndexNowSetup } from "../indexnow/hooks/useIndexNowSetup";
import { useIndexNowSubmit } from "../indexnow/hooks/useIndexNowSubmit";
import { trackIndexNowEvent } from "../indexnow/telemetry";

export type IndexNowOfferProps = {
  brandKey: string;
  url: string;
  contentItemId: string;
};

type OfferResult =
  | { kind: "submitted"; message: string }
  | { kind: "recent" }
  | { kind: "failed"; message: string };

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function IndexNowOffer({ brandKey, url, contentItemId }: IndexNowOfferProps) {
  const workspace = useWorkspace();
  const features = workspace?.features ?? null;
  const flagOn = features?.indexnow === true;

  const [dismissed, setDismissed] = useState(false);
  const [result, setResult] = useState<OfferResult | null>(null);
  const shownRef = useRef<string | null>(null);

  const setup = useIndexNowSetup(brandKey);
  const submit = useIndexNowSubmit(brandKey);

  const urlHost = hostOf(url);

  const data = setup.data ?? null;
  const key = data?.key ?? null;
  const hosts = data?.hosts ?? null;
  const domain = data?.domain ?? brandKey;

  const offerHost = urlHost ?? domain;
  const match = offerHost
    ? (hosts?.find((h) => h.host.toLowerCase() === offerHost) ?? null)
    : null;
  const verified = match?.status === "found";

  const state: string | null = !flagOn
    ? null
    : setup.isLoading
      ? "loading"
      : setup.error || !data
        ? "error"
        : !key
          ? "no_key"
          : !verified
            ? "unverified"
            : result?.kind === "submitted"
              ? "submitted"
              : result?.kind === "recent"
                ? "recent"
                : result?.kind === "failed"
                  ? "failed"
                  : "ready";

  useEffect(() => {
    if (state === "no_key" || state === "unverified" || state === "ready") {
      if (shownRef.current !== state) {
        shownRef.current = state;
        trackIndexNowEvent("indexnow:offer_shown", { state });
      }
    }
  }, [state]);

  async function handleSubmit() {
    try {
      const res = await submit.mutateAsync({
        urls: [url],
        source: "content",
        sourceRef: contentItemId,
      });
      const recent = res.skipped.some(
        (s) => s.url === url && s.reason === "recently_submitted",
      );
      if (recent) {
        setResult({ kind: "recent" });
        return;
      }
      const hostResult =
        (offerHost
          ? res.hosts.find((h) => h.host.toLowerCase() === offerHost)
          : null) ??
        res.hosts[0] ??
        null;
      if (!hostResult) {
        const firstSkipped = res.skipped[0] ?? null;
        if (firstSkipped?.reason === "recently_submitted") {
          setResult({ kind: "recent" });
        } else {
          setResult({
            kind: "failed",
            message: "IndexNow didn't respond. Try again later.",
          });
        }
        return;
      }
      if (hostResult.status === "submitted") {
        const message =
          hostResult.httpStatus === 200
            ? "Submitted. Bing and the other IndexNow engines will recrawl it soon."
            : hostResult.message;
        setResult({ kind: "submitted", message });
      } else {
        setResult({ kind: "failed", message: hostResult.message });
      }
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Couldn't submit to IndexNow.";
      setResult({ kind: "failed", message });
    }
  }

  function handleDismiss() {
    setDismissed(true);
    trackIndexNowEvent("indexnow:offer_dismissed", {});
  }

  async function handleRetry() {
    setResult(null);
    await handleSubmit();
  }

  if (!flagOn) return null;
  if (!brandKey || !url) return null;
  if (dismissed) return null;
  if (setup.isLoading) return null;
  if (setup.error || !data) return null;

  if (!key) {
    return (
      <div className="w-full max-w-full">
        <Alert variant="info">
          <AlertTitle>Tell Bing about this page?</AlertTitle>
          <AlertDescription>
            Set up IndexNow in Workspace settings to submit pages as you
            publish them.{" "}
            <Link
              href="/portal/settings/indexnow"
              className="font-medium text-primary underline underline-offset-3 hover:text-foreground"
            >
              Set up IndexNow
            </Link>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!verified) {
    return (
      <div className="w-full max-w-full">
        <Alert variant="info">
          <AlertTitle>Key file not verified</AlertTitle>
          <AlertDescription>
            <span className="break-all">
              Your IndexNow key file isn&apos;t verified on {offerHost} yet.{" "}
            </span>
            <Link
              href="/portal/settings/indexnow"
              className="font-medium text-primary underline underline-offset-3 hover:text-foreground"
            >
              Check key file
            </Link>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (result?.kind === "submitted") {
    return (
      <div className="w-full max-w-full">
        <Alert variant="success">
          <AlertTitle>Submitted to IndexNow</AlertTitle>
          <AlertDescription className="break-all">
            {result.message}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (result?.kind === "recent") {
    return (
      <div className="w-full max-w-full">
        <Alert variant="info">
          <AlertDescription>
            This page was submitted in the last 10 minutes.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (result?.kind === "failed") {
    return (
      <div className="w-full max-w-full">
        <Alert variant="destructive">
          <AlertTitle>Submission failed</AlertTitle>
          <AlertDescription className="space-y-2">
            <span className="block break-all">{result.message}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleRetry()}
              pending={submit.isPending}
            >
              {submit.isPending ? "Submitting…" : "Try again"}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="w-full max-w-full">
      <Alert variant="info">
        <AlertTitle>Tell Bing about this page?</AlertTitle>
        <AlertDescription className="space-y-3">
          <span className="block">
            Tell Bing and other IndexNow search engines about this page now?
            It&apos;s free.
          </span>
          <span className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSubmit()}
              pending={submit.isPending}
            >
              {submit.isPending ? "Submitting…" : "Submit to IndexNow"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDismiss}
              disabled={submit.isPending}
            >
              Not now
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    </div>
  );
}

export default IndexNowOffer;
