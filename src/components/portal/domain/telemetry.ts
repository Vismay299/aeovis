// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/posthog.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type DomainEvent =
  | {
      event: "domain_overview:lookup";
      properties: { scope: string; cached: boolean; has_data: boolean };
    }
  | { event: "domain_overview:tab"; properties: { tab: string } }
  | {
      event: "keyword:save";
      properties: { source_feature: "domain_overview"; keyword_count: number };
    }
  | {
      event: "domain_overview:competitors";
      properties: { keyword_count: number; result_count: number };
    }
  | {
      event: "domain_overview:add_competitor";
      properties?: Record<string, unknown>;
    };

export type DomainEventTracker = (
  event: DomainEvent["event"],
  properties?: Record<string, unknown>,
) => void;

let currentTracker: DomainEventTracker | null = null;

export function setDomainEventTracker(fn: DomainEventTracker | null): void {
  currentTracker = fn;
}

export function trackDomainEvent(
  event: DomainEvent["event"],
  properties?: Record<string, unknown>,
): void {
  try {
    currentTracker?.(event, properties);
  } catch {
    // Telemetry must never throw or disrupt the UI
  }
}
