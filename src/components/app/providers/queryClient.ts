import { toast } from "sonner";
import type { QueryClient } from "@tanstack/query-core";
import { createQueryClient } from "@/lib/query/queryClient";

let browserClient: QueryClient | undefined;

function makeClient(): QueryClient {
  return createQueryClient({
    toastError: (title, description) =>
      toast.error(title, description ? { description } : undefined),
  });
}

/**
 * The shared QueryClient. On the server every call returns a new client, so one
 * request's cache never reaches another. In the browser there is one client for
 * the page's lifetime.
 */
export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") {
    return makeClient();
  }
  browserClient ??= makeClient();
  return browserClient;
}
