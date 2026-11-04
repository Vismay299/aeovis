"use client";

import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Shared root providers for app surfaces.
 * Wraps children with TooltipProvider.
 * F05 will add QueryClientProvider; F06 will add ExportToSheetsModal.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}
