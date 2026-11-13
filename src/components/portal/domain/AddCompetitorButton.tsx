"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/AddCompetitorButton.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useState, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/query/fetchJson";
import { describeError } from "@/lib/query/errors";
import { trackDomainEvent } from "./telemetry";

type ButtonVariant = ComponentProps<typeof Button>["variant"];
type ButtonSize = ComponentProps<typeof Button>["size"];

export type AddCompetitorResponse = {
  competitor: { domain: string; name: string | null };
  added: boolean;
};

/**
 * True only when F07 may store this domain: project memory on, the domain is
 * not the workspace's own site and it is not declared already.
 */
export function canOfferAddCompetitor({
  hasProjectMemory,
  isOwnSite,
  isDeclaredCompetitor,
}: {
  hasProjectMemory: boolean;
  isOwnSite: boolean;
  isDeclaredCompetitor: boolean;
}): boolean {
  return hasProjectMemory && !isOwnSite && !isDeclaredCompetitor;
}

type Props = {
  brandKey: string;
  domain: string;
  name?: string;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Runs after the write; the caller refreshes declared competitors. */
  onAdded?: (domain: string) => void;
};

/** Adds a domain to F07's declared competitors. Free and idempotent. */
export function AddCompetitorButton({
  brandKey,
  domain,
  name,
  disabled = false,
  variant = "outline",
  size = "default",
  onAdded,
}: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const handleClick = async () => {
    setPending(true);
    try {
      await fetchJson<AddCompetitorResponse>(
        `/api/customer/domain/competitors/add?brand_key=${encodeURIComponent(brandKey)}`,
        {
          method: "POST",
          body: name ? { domain, name } : { domain },
        },
      );
      trackDomainEvent("domain_overview:add_competitor");
      toast.success(`Added ${domain} to your competitors.`, {
        action: {
          label: "View context",
          onClick: () => router.push("/portal/context"),
        },
      });
      onAdded?.(domain);
    } catch (error) {
      toast.error(
        describeError(error, "Could not add this competitor. Please retry."),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      pending={pending}
      onClick={() => void handleClick()}
    >
      <UserPlus data-icon="inline-start" />
      Add as competitor
    </Button>
  );
}
