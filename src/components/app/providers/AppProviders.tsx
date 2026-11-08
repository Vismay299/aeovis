"use client";

import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getQueryClient } from "@/components/app/providers/queryClient";
import { ExportToSheetsModal } from "@/components/app/table/ExportToSheetsModal";
import { TelemetryBootstrap } from "@/components/app/telemetry/TelemetryBootstrap";

/**
 * Shared root providers for app surfaces.
 * Wraps children with QueryClientProvider and TooltipProvider.
 * F06 mounts ExportToSheetsModal.
 * F26 mounts TelemetryBootstrap.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(getQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TelemetryBootstrap />
        {children}
        <ExportToSheetsModal />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

