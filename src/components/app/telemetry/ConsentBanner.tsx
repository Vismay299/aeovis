"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { AppBanner } from "@/components/app/AppBanner";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/components/app/workspace/WorkspaceContext";
import { hasGlobalPrivacyControl } from "@/shared/privacy-choices";
import { useAnalyticsConsent } from "./useAnalyticsConsent";

export function ConsentBanner() {
  const pathname = usePathname() || "";
  const { available, choice, save } = useAnalyticsConsent();
  const workspace = useWorkspace();
  const [savingAction, setSavingAction] = useState<"share" | "nothanks" | null>(null);

  const gpc = hasGlobalPrivacyControl();
  const enabled = workspace?.features?.product_analytics === true;

  if (!available || choice !== null || gpc || !enabled || pathname === "/onboarding") {
    return null;
  }

  const isSaving = savingAction !== null;

  async function handleChoice(analytics: boolean) {
    setSavingAction(analytics ? "share" : "nothanks");
    try {
      await save(analytics, "banner");
      if (analytics) {
        toast.success(
          "Thanks — usage analytics is on. Change it any time in Settings → Privacy.",
        );
      }
    } catch {
      toast.error("Your privacy settings couldn't be saved. Please retry.");
    } finally {
      setSavingAction(null);
    }
  }

  return (
    <AppBanner variant="info">
      <div
        role="region"
        aria-label="Analytics choice"
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 w-full"
      >
        <p className="text-sm">
          Help improve Perceev? Share which pages and features you use. We never
          record your questions, AI answers or website data.{" "}
          <Link
            href="/privacy"
            className="text-foreground underline underline-offset-2"
          >
            Privacy Policy
          </Link>
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="xs"
            disabled={isSaving}
            pending={savingAction === "share"}
            onClick={() => handleChoice(true)}
          >
            Share analytics
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={isSaving}
            pending={savingAction === "nothanks"}
            onClick={() => handleChoice(false)}
          >
            No thanks
          </Button>
        </div>
      </div>
    </AppBanner>
  );
}
