"use client";

import Link from "next/link";
import { Switch } from "@/components/ui/switch";

export function AnalyticsConsentSwitch({
  source,
  value,
  onChange,
  disabled = false,
}: {
  source: "onboarding" | "settings";
  value: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <p className="text-sm font-medium">Usage analytics</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Share which pages and features you use to help improve Perceev. We never
          record your questions, AI answers, website data or screen. See our{" "}
          <Link
            href="/privacy"
            className="text-foreground underline underline-offset-2"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </div>
      <Switch
        checked={value}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label="Share usage analytics"
      />
    </div>
  );
}
