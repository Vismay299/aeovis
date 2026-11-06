"use client";

import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getQueryClient } from "@/components/app/providers/queryClient";
import { ExportToSheetsModal } from "@/components/app/table/ExportToSheetsModal";

/**
 * Shared root providers for app surfaces.
 * Wraps children with QueryClientProvider and TooltipProvider.
 * F06 mounts ExportToSheetsModal.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(getQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {children}
        <ExportToSheetsModal />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
