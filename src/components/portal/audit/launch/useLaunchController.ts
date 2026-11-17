// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/launch/useLaunchController.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the launch form's controller: input state, the large-audit
// confirmation, the paid-options cost dialog and the start mutation.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { PriceQuote } from "@/shared/pricing";
import {
  LARGE_AUDIT_CONFIRM_PAGES,
  estimatedCrawlMinutes,
} from "@/shared/audit-limits";
import { ApiError } from "@/shared/query/fetchJson";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { useAuditList } from "../hooks/useAuditList";
import { useDeleteAudit } from "../hooks/useDeleteAudit";
import { useStartAudit } from "../hooks/useStartAudit";
import { trackAuditEvent } from "../telemetry";
import { clampMaxPagesInput } from "./types";

export type AuditFormError = { message: string; activeAuditId?: string };

export function useLaunchController({ brandKey }: { brandKey: string }) {
  const router = useRouter();
  const list = useAuditList(brandKey);
  const start = useStartAudit(brandKey);
  const remove = useDeleteAudit(brandKey);

  const [startUrl, setStartUrl] = useState("");
  const [maxPagesText, setMaxPagesText] = useState("50");
  const [lighthouse, setLighthouse] = useState(false);
  const [renderJavaScript, setRenderJavaScript] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<AuditFormError | null>(null);
  const [confirmPages, setConfirmPages] = useState<number | null>(null);
  const [costOpen, setCostOpen] = useState(false);
  const [pendingInput, setPendingInput] = useState<{
    maxPages: number;
    lighthouse: boolean;
    renderJavaScript: boolean;
  } | null>(null);
  const [priceChanged, setPriceChanged] = useState<{
    approvedMaxUsd: number;
    quote: PriceQuote;
  } | null>(null);
  const [pending, setPending] = useState(false);

  const capabilities = list.capabilities;
  const maxPagesLimit = capabilities?.maxPages ?? 10_000;
  const renderedLimit = Math.min(
    capabilities?.renderedMaxPages ?? 1_000,
    maxPagesLimit,
  );
  const effectiveLimit = renderJavaScript ? renderedLimit : maxPagesLimit;

  // Prefill the workspace website once the capabilities arrive. A ref keeps a
  // field the customer cleared from being filled again on every render.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!prefilled.current && capabilities?.defaultUrl) {
      prefilled.current = true;
      setStartUrl(capabilities.defaultUrl);
    }
  }, [capabilities?.defaultUrl]);

  const quote = usePriceQuote(
    {
      brandKey,
      action: "site_audit.run",
      input: pendingInput ?? {
        maxPages: clampMaxPagesInput(maxPagesText, effectiveLimit),
        lighthouse,
        renderJavaScript,
      },
    },
    { enabled: costOpen },
  );

  const parsedMaxPages = useMemo(
    () => clampMaxPagesInput(maxPagesText, effectiveLimit),
    [maxPagesText, effectiveLimit],
  );

  function commitMaxPages() {
    setMaxPagesText(String(parsedMaxPages));
  }

  function proceed(pages: number) {
    if (lighthouse || renderJavaScript) {
      setPendingInput({ maxPages: pages, lighthouse, renderJavaScript });
      setPriceChanged(null);
      setCostOpen(true);
      return;
    }
    void run(pages);
  }

  async function run(pages: number, maxUsd?: number) {
    setPending(true);
    setFormError(null);
    try {
      const result = await start.mutateAsync({
        startUrl: startUrl.trim(),
        maxPages: pages,
        lighthouse,
        renderJavaScript,
        ...(maxUsd != null ? { maxUsd } : {}),
      });
      setCostOpen(false);
      setConfirmPages(null);
      setPriceChanged(null);
      toast.success("Audit started");
      router.push(`/portal/audit/${result.auditId}`);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.code === "price_changed") {
        const quoteDetails = apiError.details?.quote as PriceQuote | undefined;
        const approved = Number(apiError.details?.approvedMaxUsd ?? 0);
        if (quoteDetails) {
          setPriceChanged({ approvedMaxUsd: approved, quote: quoteDetails });
          return;
        }
      }
      setCostOpen(false);
      setConfirmPages(null);
      const activeAuditId =
        apiError?.code === "audit_already_running" &&
        typeof apiError.details?.activeAuditId === "string"
          ? apiError.details.activeAuditId
          : undefined;
      setFormError({
        message:
          apiError?.message ?? "The audit could not be started. Please retry.",
        ...(activeAuditId ? { activeAuditId } : {}),
      });
    } finally {
      setPending(false);
    }
  }

  function submit() {
    const pages = clampMaxPagesInput(maxPagesText, effectiveLimit);
    setMaxPagesText(String(pages));
    if (!startUrl.trim()) {
      setFieldError("Please enter a URL.");
      return;
    }
    setFieldError(null);
    setFormError(null);
    if (pages > LARGE_AUDIT_CONFIRM_PAGES) {
      trackAuditEvent("site_audit:large_confirm", { pages });
      setConfirmPages(pages);
      return;
    }
    proceed(pages);
  }

  function confirmLarge() {
    const pages = confirmPages;
    setConfirmPages(null);
    if (pages != null) proceed(pages);
  }

  function confirmCost(maxUsd: number) {
    if (!pendingInput) return;
    void run(pendingInput.maxPages, maxUsd);
  }

  function closeCost() {
    if (pending) return;
    setCostOpen(false);
    setPriceChanged(null);
  }

  async function deleteAudit(auditId: string): Promise<boolean> {
    trackAuditEvent("site_audit:delete");
    try {
      await remove.mutateAsync(auditId);
      toast.success("Audit deleted");
      return true;
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "The audit could not be deleted.",
      );
      return false;
    }
  }

  return {
    list,
    audits: list.audits,
    capabilities,
    startUrl,
    setStartUrl,
    maxPagesText,
    setMaxPagesText,
    commitMaxPages,
    maxPages: parsedMaxPages,
    maxPagesLimit,
    renderedLimit,
    effectiveLimit,
    lighthouse,
    setLighthouse,
    renderJavaScript,
    setRenderJavaScript,
    fieldError,
    formError,
    confirmPages,
    confirmLarge,
    submit,
    pending,
    costOpen,
    quote,
    priceChanged,
    confirmCost,
    closeCost,
    deleteAudit,
    deleting: remove.isPending,
    estimatedMinutes: (pages: number) => estimatedCrawlMinutes(pages),
  };
}

export type LaunchController = ReturnType<typeof useLaunchController>;
