// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/onboarding/WizardFooter.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WizardFooter({
  onBack,
  onSkip,
  onPrimary,
  primaryLabel,
  showBack = true,
  showSkip = true,
  primaryDisabled = false,
  pending = false,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  onPrimary: () => void;
  primaryLabel: string;
  showBack?: boolean;
  showSkip?: boolean;
  primaryDisabled?: boolean;
  pending?: boolean;
}) {
  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        {showBack ? <Button type="button" variant="ghost" onClick={onBack} disabled={!onBack}><ArrowLeft aria-hidden="true" />Back</Button> : null}
        {showSkip ? <Button type="button" variant="ghost" onClick={onSkip}>Skip for now</Button> : null}
      </div>
      <Button type="button" onClick={onPrimary} disabled={primaryDisabled} pending={pending}>
        {primaryLabel}<ArrowRight aria-hidden="true" />
      </Button>
    </div>
  );
}
