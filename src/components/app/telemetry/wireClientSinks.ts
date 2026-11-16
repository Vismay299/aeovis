import { trackEvent } from "../../../lib/telemetry/client.ts";
import type { ClientEventName, EventProps } from "../../../lib/telemetry/events.ts";
import { setExportTracker } from "../../../lib/export/telemetry.ts";
import { setKeywordEventTracker } from "../../portal/keywords/telemetry.ts";
import { setDomainEventTracker } from "../../portal/domain/telemetry.ts";
import { setRankEventTracker } from "../../portal/rank-tracking/telemetry.ts";
import { setBacklinksEventTracker } from "../../portal/backlinks/telemetry.ts";
import { setLocalEventTracker } from "../../portal/local/telemetry.ts";
import { setAuditEventTracker } from "../../portal/audit/telemetry.ts";
import { setIndexNowEventTracker } from "../../portal/indexnow/telemetry.ts";
import { setGa4EventTracker } from "../../portal/analytics/telemetry.ts";
import { setAuthEventTracker } from "../../auth/telemetry.ts";
import { setOnboardingEventTracker } from "../../portal/onboarding/telemetry.ts";

/**
 * Client telemetry sinks wiring (F26 §6.2.7).
 *
 * One sink per feature, attached to the F26 browser capture. A feature merged
 * later adds its own line here in its PR; the wiring test fails when a registry
 * name is neither reachable from a sink nor listed as pending.
 */
export type ClientSinkTracker = (name: string, props: Record<string, unknown>) => void;

export type WireClientSinkDeps = {
  /** Test seam: record the sink calls without loading posthog-js. */
  trackEvent?: ClientSinkTracker;
};

const defaultTrackEvent: ClientSinkTracker = (name, props) =>
  trackEvent(name as ClientEventName, props as EventProps<ClientEventName>);

let installed: ClientSinkTracker | null = null;

export function wireClientSinks(deps?: WireClientSinkDeps): void {
  const track = deps?.trackEvent ?? defaultTrackEvent;
  // Idempotent: a second mount or a second call with the same tracker is a no-op.
  if (installed === track) return;
  installed = track;

  setExportTracker(track);
  setKeywordEventTracker(track);
  setDomainEventTracker((name, props) => track(name, props ?? {}));
  setRankEventTracker((name, props) => track(name, props ?? {}));
  setBacklinksEventTracker((name, props) => track(name, props ?? {}));
  setLocalEventTracker((name, props) => track(name, props ?? {}));
  setAuditEventTracker(track);
  setIndexNowEventTracker((name, props) => track(name, props ?? {}));
  setGa4EventTracker((name, props) => track(name, props ?? {}));
  setAuthEventTracker((name, props) => track(name, props ?? {}));
  setOnboardingEventTracker((name, props) => track(name, props as Record<string, unknown>));
}
