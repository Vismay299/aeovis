import { keys } from "./keys.ts";
import { fetchJson, withBrand } from "./fetchJson.ts";

export function featuresQueryOptions(brandKey: string) {
  return {
    queryKey: keys.features(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<{ features: Record<string, boolean> }>(
        withBrand("/api/customer/features", brandKey),
        { signal }
      ),
    enabled: Boolean(brandKey),
  };
}

export function overviewQueryOptions(brandKey: string) {
  return {
    queryKey: keys.overview(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<Record<string, unknown>>(
        withBrand("/api/customer/overview", brandKey),
        { signal }
      ),
    enabled: Boolean(brandKey),
  };
}

export function gscQueryOptions(brandKey: string) {
  return {
    queryKey: keys.gsc(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<Record<string, unknown>>(
        withBrand("/api/customer/gsc", brandKey),
        { signal }
      ),
    enabled: Boolean(brandKey),
  };
}

export function panelQueryOptions(brandKey: string) {
  return {
    queryKey: keys.panel(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<{ items: Array<{ artifact_key: string; state: string }> }>(
        withBrand("/api/customer/repairs/panel", brandKey),
        { signal }
      ),
    enabled: Boolean(brandKey),
    staleTime: 0,
  };
}

export function scanReportQueryOptions(scanId: string) {
  return {
    queryKey: keys.scanReport(scanId),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<Record<string, unknown>>(
        `/api/customer/scan/report/${encodeURIComponent(scanId)}`,
        { signal }
      ),
    enabled: Boolean(scanId),
  };
}
