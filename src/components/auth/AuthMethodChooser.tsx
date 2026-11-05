// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/auth/AuthPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { Button } from "@/components/ui/button";
import { GoogleLogo } from "./GoogleLogo";

export interface AuthMethodChooserProps {
  googleLabel: string;
  emailLabel?: string;
  busy?: boolean;
  isBusy?: boolean;
  disabled?: boolean;
  onGoogle?: () => void;
  onContinueWithGoogle?: () => void;
  onEmail?: () => void;
  onContinueWithEmail?: () => void;
}

export function AuthMethodChooser({
  googleLabel,
  emailLabel = "Continue with email",
  busy = false,
  isBusy,
  disabled = false,
  onGoogle,
  onContinueWithGoogle,
  onEmail,
  onContinueWithEmail,
}: AuthMethodChooserProps) {
  const activeBusy = busy || isBusy || false;
  const handleGoogle = onGoogle ?? onContinueWithGoogle;
  const handleEmail = onEmail ?? onContinueWithEmail;

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        className="w-full border-black/10 !bg-white font-semibold !text-neutral-900 hover:border-black/20 hover:!bg-neutral-50"
        onClick={handleGoogle}
        disabled={disabled || activeBusy}
      >
        <GoogleLogo />
        {activeBusy ? "Opening Google..." : googleLabel}
      </Button>

      <Button
        type="button"
        variant="outline"
        className="w-full bg-card font-semibold dark:border-border dark:bg-card"
        onClick={handleEmail}
        disabled={disabled || activeBusy}
      >
        {emailLabel}
      </Button>
    </div>
  );
}
