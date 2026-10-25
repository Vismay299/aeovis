// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/posthog.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { keepAlive as defaultKeepAlive } from "../keepAlive.js";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { isFeatureEnabled as defaultIsFeatureEnabled } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { AppError } from "../http/appError.ts";
import { currentTelemetryContext } from "./context.ts";
import {
  EVENTS,
  validateEventProps,
  type EventProps,
  type ServerEventName,
} from "./events.ts";
import { hasConsent, telemetryIdFor } from "./privacy.ts";

type PostHogLike = {
  capture: (args: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
  }) => void;
  captureExceptionImmediate: (
    error: Error,
    distinctId?: string,
    properties?: Record<string, unknown>,
  ) => Promise<void>;
  shutdown: () => Promise<void>;
};

export type ServerDeps = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  admin?: SupabaseClient | null;
  client?: (key: string, host: string) => PostHogLike;
  isFeatureEnabled?: (name: FeatureName, brandKey?: string) => Promise<boolean>;
  keepAlive?: typeof defaultKeepAlive;
  now?: () => number;
};

const NON_REPORTABLE = new Set([
  "unauthenticated",
  "auth_not_configured",
  "workspace_not_found",
  "forbidden",
  "owner_required",
  "feature_unavailable",
  "feature_disabled",
  "invalid_request",
  "invalid_input",
  "approval_required",
  "price_changed",
  "daily_cap",
  "workspace_cap",
  "over_approved_max",
  "job_already_running",
  "rate_limited",
  "upstream_unavailable",
  "not_found",
  "cancelled",
]);

export function serverTelemetryEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  if (String(env.TELEMETRY_DISABLED ?? "") === "1") return false;
  const key = String(env.POSTHOG_PROJECT_KEY ?? "").trim();
  return Boolean(key);
}

function appErrorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

/**
 * The error as error tracking receives it: type, AppError code and stack
 * frames, never its message (messages can quote customer content).
 */
export function withoutMessage(error: unknown, depth = 0): Error {
  const redacted = new Error(appErrorCode(error));
  if (!(error instanceof Error)) {
    redacted.stack = `Error: ${redacted.message}`;
    return redacted;
  }
  redacted.name = error.name;
  const frames = (error.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line));
  redacted.stack = [`${error.name}: ${redacted.message}`, ...frames].join("\n");
  if (error.cause !== undefined && depth < 4) {
    (redacted as Error & { cause?: Error }).cause = withoutMessage(error.cause, depth + 1);
  }
  return redacted;
}

export function isReportableErrorCode(code: string | null | undefined): boolean {
  if (!code) return true;
  return !NON_REPORTABLE.has(code);
}

async function defaultClient(key: string, host: string): Promise<PostHogLike> {
  const mod = await import("posthog-node");
  const PostHog = mod.PostHog as unknown as new (
    key: string,
    opts: { host: string; flushAt: number; flushInterval: number; disableGeoip: boolean },
  ) => PostHogLike;
  return new PostHog(key, {
    host,
    flushAt: 1,
    flushInterval: 0,
    disableGeoip: true,
  });
}

async function getClient(deps: ServerDeps | undefined, env: Record<string, string | undefined>): Promise<PostHogLike | null> {
  if (!serverTelemetryEnabled(env)) return null;
  const key = String(env.POSTHOG_PROJECT_KEY ?? "").trim();
  const host = String(env.POSTHOG_HOST ?? "https://eu.i.posthog.com").trim() || "https://eu.i.posthog.com";
  if (deps?.client) return deps.client(key, host);
  return defaultClient(key, host);
}

export async function captureServerEvent<N extends ServerEventName>(
  i: {
    name: N;
    props: EventProps<N>;
    userId?: string | null;
    brandKey?: string | null;
  },
  deps?: ServerDeps,
): Promise<void> {
  const run = async () => {
    try {
      const env = (deps?.env ?? process.env) as Record<string, string | undefined>;
      if (!serverTelemetryEnabled(env)) return;

      const ctx = currentTelemetryContext();
      const brandKey = i.brandKey !== undefined ? i.brandKey : ctx.brandKey;
      const userId = i.userId !== undefined ? i.userId : ctx.userId;

      const flagOn = await (deps?.isFeatureEnabled ?? defaultIsFeatureEnabled)(
        "product_analytics",
        brandKey ?? undefined,
      );
      if (!flagOn) return;

      const validated = validateEventProps(i.name, i.props);
      if (!validated.ok) {
        console.warn("[telemetry] invalid event", { name: i.name, reason: validated.reason });
        return;
      }

      const admin = deps && "admin" in deps ? deps.admin : getSupabaseAdmin();
      const consented = await hasConsent(admin ?? undefined, userId, deps?.now?.() ?? Date.now());
      const spec = EVENTS[i.name];

      let distinctId: string;
      let groups: Record<string, string> | undefined;
      let properties: Record<string, unknown> = {
        ...validated.props,
        $lib_custom: "perceev-server",
      };

      if (consented && userId) {
        distinctId = userId;
        const tid = await telemetryIdFor(admin ?? undefined, brandKey, deps?.now?.() ?? Date.now());
        if (tid) groups = { workspace: tid };
      } else if (spec.consent === "anonymous") {
        distinctId = `anon:${randomUUID()}`;
        properties = { ...properties, $process_person_profile: false };
        groups = undefined;
      } else {
        return;
      }

      const client = await getClient(deps, env);
      if (!client) return;
      try {
        client.capture({
          distinctId,
          event: i.name,
          properties,
          groups,
        });
      } finally {
        try {
          await client.shutdown();
        } catch {
          /* swallow */
        }
      }
    } catch (err) {
      console.warn("[telemetry] capture failed");
      void err;
    }
  };

  // Await the capture so callers/tests observe side effects; also hand the same
  // promise to keepAlive so a disconnected response still finishes the flush.
  const work = run();
  const ka = deps?.keepAlive ?? defaultKeepAlive;
  try {
    ka(work);
  } catch {
    /* keepAlive must never break capture */
  }
  await work;
}

export async function captureServerError(
  error: unknown,
  props: {
    route?: string;
    job_kind?: string;
    tool?: string;
    error_code?: string;
    issues?: string;
  } = {},
  userId?: string | null,
  deps?: ServerDeps,
): Promise<void> {
  try {
    const env = (deps?.env ?? process.env) as Record<string, string | undefined>;
    if (!serverTelemetryEnabled(env)) return;

    const code = props.error_code ?? appErrorCode(error) ?? null;
    if (!isReportableErrorCode(code)) return;

    const ctx = currentTelemetryContext();
    const uid = userId !== undefined ? userId : ctx.userId;
    const admin = deps && "admin" in deps ? deps.admin : getSupabaseAdmin();
    const consented = await hasConsent(admin ?? undefined, uid, deps?.now?.() ?? Date.now());
    const distinctId = consented && uid ? uid : "server";
    const properties: Record<string, unknown> = {
      source: "server",
      ...props,
    };
    if (!(consented && uid)) {
      properties.$process_person_profile = false;
    }

    const client = await getClient(deps, env);
    if (!client) return;
    try {
      await client.captureExceptionImmediate(withoutMessage(error), distinctId, properties);
    } finally {
      try {
        await client.shutdown();
      } catch {
        /* swallow shutdown errors */
      }
    }
  } catch {
    console.warn("[telemetry] capture failed");
  }
}
