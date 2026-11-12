"use client";

import { usePortal } from "@/components/portal/PortalShell";
import { BacklinksPage } from "@/components/portal/backlinks/BacklinksPage";

export default function BacklinksRoutePage() {
  const { brandKey } = usePortal();
  return <BacklinksPage brandKey={brandKey || ""} />;
}
