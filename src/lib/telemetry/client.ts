// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/posthog.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
import { validateEventProps, type ClientEventName, type EventProps } from "./events.ts";
import { sanitizeEvent } from "./sanitize.ts";
import { clearPrivacyCookie } from "../../shared/privacy-choices.ts";

type PostHogClient = {
  init: (key: string, opts: Record<string, unknown>) => void;
  capture: (event: string, properties?: Record<string, unknown>) => void;
  identify: (id: string) => void;
  group: (type: string, id: string) => void;
  reset: () => void;
  opt_in_capturing: (opts?: { captureEventName?: boolean | string }) => void;
  opt_out_capturing: () => void;
  captureException: (error: unknown, properties?: Record<string, unknown>) => void;
};

export type LoadPostHog = () => Promise<PostHogClient | null>;

type ClientModuleState = {
  clientPromise: Promise<PostHogClient | null> | null;
  analyticsCaptureEnabled: boolean;
  eventsBeforeChoices: Array<[string, Record<string, unknown> | undefined]> | null;
  clientErrorCaptureStopped: boolean;
  lastInitOptions: Record<string, unknown> | null;
  identity: { userId: string; workspaceTelemetryId: string | null } | null;
  loadPostHog: LoadPostHog;
};

function defaultLoadPostHog(): Promise<PostHogClient | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const key = String(process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "").trim();
  if (!key || String(process.env.NEXT_PUBLIC_TELEMETRY_DISABLED ?? "") === "1") {
    return Promise.resolve(null);
  }
  return import("posthog-js").then((mod) => mod.default as unknown as PostHogClient).catch(() => null);
}

const state: ClientModuleState = {
  clientPromise: null,
  analyticsCaptureEnabled: false,
  eventsBeforeChoices: [],
  clientErrorCaptureStopped: false,
  lastInitOptions: null,
  identity: null,
  loadPostHog: defaultLoadPostHog,
};

/** Test-only: inject loader and reset module state. */
export function __resetClientForTests(loadPostHog?: LoadPostHog): void {
  state.clientPromise = null;
  state.analyticsCaptureEnabled = false;
  state.eventsBeforeChoices = [];
  state.clientErrorCaptureStopped = false;
  state.lastInitOptions = null;
  state.identity = null;
  if (loadPostHog) state.loadPostHog = loadPostHog;
  else state.loadPostHog = defaultLoadPostHog;
}

export function __lastInitOptionsForTests(): Record<string, unknown> | null {
  return state.lastInitOptions;
}

type ExceptionEntry = {
  value?: unknown;
  mechanism?: { synthetic?: boolean };
  stacktrace?: { frames?: unknown[] };
};

function isIgnorableException(properties: Record<string, unknown> | undefined): boolean {
  const list = properties?.["$exception_list"];
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every((entry: ExceptionEntry) => {
    const value = typeof entry?.value === "string" ? entry.value : "";
    if (value.includes("Object Not Found Matching Id")) return true;
    if (value === "Script error.") return true;
    if (value.includes("signal is aborted without reason")) return true;
    if (value.includes("ResizeObserver loop")) return true;
    if (value.includes("PostHog request timed out")) return true;
    if (value === "CancelledError") return true;
    if (value === "ChunkLoadError" || value.includes("Loading chunk")) return true;
    const frames = entry?.stacktrace?.frames;
    return (
      value === "undefined" &&
      entry?.mechanism?.synthetic === true &&
      (!Array.isArray(frames) || frames.length === 0)
    );
  });
}

function buildInitOptions(): Record<string, unknown> {
  return {
    api_host: "/ingest",
    ui_host: String(process.env.NEXT_PUBLIC_POSTHOG_UI_HOST ?? "https://eu.posthog.com"),
    defaults: "2026-01-30",
    autocapture: false,
    capture_pageview: "history_change",
    capture_pageleave: false,
    capture_exceptions: true,
    disable_session_recording: true,
    disable_surveys: true,
    person_profiles: "identified_only",
    opt_out_capturing_by_default: true,
    opt_out_persistence_by_default: true,
    // Consent gate is ours — DNT must not override an explicit Settings/onboarding opt-in.
    respect_dnt: false,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: true,
    before_send(event: { event?: string; properties?: Record<string, unknown> } | null) {
      if (!event) return null;
      if (event.event === "$exception" && isIgnorableException(event.properties)) return null;
      return sanitizeEvent(event);
    },
  };
}

function getClient(): Promise<PostHogClient | null> {
  if (state.clientPromise) return state.clientPromise;
  state.clientPromise = state.loadPostHog().then((client) => {
    if (!client) return null;
    const key = String(process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "phc_test").trim();
    if (!key) return null;
    const opts = buildInitOptions();
    state.lastInitOptions = opts;
    client.init(key, opts);
    return client;
  });
  return state.clientPromise;
}

function withClient(fn: (client: PostHogClient) => void): void {
  void getClient().then((client) => {
    if (!client) return;
    try {
      fn(client);
    } catch {
      /* never throw from telemetry */
    }
  });
}

function applyIdentity(client: PostHogClient): void {
  if (!state.identity) return;
  client.identify(state.identity.userId);
  if (state.identity.workspaceTelemetryId) {
    client.group("workspace", state.identity.workspaceTelemetryId);
  }
}

export function trackEvent<N extends ClientEventName>(name: N, props: EventProps<N>): void {
  const validated = validateEventProps(name, props);
  if (!validated.ok) {
    if (typeof console !== "undefined") {
      console.warn("[telemetry] invalid event", { name, reason: validated.reason });
    }
    return;
  }
  if (!state.analyticsCaptureEnabled) {
    if (state.eventsBeforeChoices && state.eventsBeforeChoices.length < 50) {
      state.eventsBeforeChoices.push([name, validated.props]);
    }
    return;
  }
  withClient((client) => client.capture(name, validated.props));
}

export function setTelemetryIdentity(args: {
  userId: string;
  workspaceTelemetryId: string | null;
}): void {
  state.identity = args;
  if (!state.analyticsCaptureEnabled) return;
  withClient((client) => applyIdentity(client));
}

/** Sign-out: drop the identity, PostHog's own state, and the cookie that carried the choice. */
export function resetTelemetry(): void {
  state.identity = null;
  withClient((client) => client.reset());
  clearPrivacyCookie();
}

/**
 * Enable capture after consent. **Must** call `opt_in_capturing` once — without
 * it, opt_out_capturing_by_default leaves consented users sending zero events.
 */
export function startAnalyticsCapture(): void {
  state.analyticsCaptureEnabled = true;
  const pending = state.eventsBeforeChoices ?? [];
  state.eventsBeforeChoices = null;
  withClient((client) => {
    if (!state.analyticsCaptureEnabled) return;
    client.opt_in_capturing({ captureEventName: false });
    applyIdentity(client);
    for (const [event, properties] of pending) {
      client.capture(event, properties);
    }
  });
}

export function stopAnalyticsCapture(): void {
  state.analyticsCaptureEnabled = false;
  state.eventsBeforeChoices = null;
  withClient((client) => {
    client.opt_out_capturing();
  });
}

export function stopClientErrorCapture(): void {
  state.clientErrorCaptureStopped = true;
}

export function captureClientError(
  error: unknown,
  properties: Record<string, string | null | undefined> = {},
): void {
  if (!state.analyticsCaptureEnabled || state.clientErrorCaptureStopped) return;
  withClient((client) =>
    client.captureException(error, {
      source: "client",
      ...properties,
    }),
  );
}
