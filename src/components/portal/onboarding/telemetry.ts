"use client";

import { trackEvent } from "../../../lib/telemetry/client.ts";
import type { ClientEventName, EventProps } from "@/lib/telemetry/events";

type OnboardingEventName = Extract<ClientEventName, `onboarding:${string}`>;
type OnboardingTracker = <N extends OnboardingEventName>(name: N, props: EventProps<N>) => void;

let tracker: OnboardingTracker = (name, props) => trackEvent(name, props);

export function setOnboardingEventTracker(next: OnboardingTracker): void {
  tracker = next;
}

export function trackOnboardingEvent<N extends OnboardingEventName>(name: N, props: EventProps<N>): void {
  tracker(name, props);
}
