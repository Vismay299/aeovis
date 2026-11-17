import { setAuditServerTracker } from "../../server/audit/telemetry.ts";
import { setAuthServerTracker } from "../../server/auth/telemetry.ts";
import { setEmailEventTracker } from "../../server/email/telemetry.ts";
import { setOnboardingServerTracker } from "../../server/onboarding/telemetry.ts";
import { currentTelemetryContext } from "./context.ts";
import { setServerErrorReporter } from "./reporters.ts";
import { captureServerError, captureServerEvent } from "./server.ts";

/**
 * Server telemetry sinks wiring (F26 §6.2.7).
 *
 * Every server sink present in the tree forwards to the F26 capture. Identity
 * comes from `currentTelemetryContext()` unless the sink passes an explicit
 * user id (F24's sign-up callback, F25's deliver job); the brand key is always
 * the request's context.
 */
export type ServerSinkTracker = (
  name: string,
  props: Record<string, unknown>,
  userId?: string | null,
) => void;

export type ServerSinkCapture = (call: {
  name: string;
  props: Record<string, unknown>;
  userId?: string | null;
  brandKey?: string | null;
}) => void | Promise<void>;

export type WireServerSinkDeps = {
  /** Test seam: record the sink calls without a PostHog client. */
  captureServerEvent?: ServerSinkCapture;
};

const defaultCaptureServerEvent: ServerSinkCapture = (call) =>
  captureServerEvent(call as never);

let installed: ServerSinkCapture | null = null;

export function wireServerSinks(deps?: WireServerSinkDeps): void {
  setServerErrorReporter((err, props) => {
    void captureServerError(err, props as { route?: string; job_kind?: string; error_code?: string });
  });

  const capture = deps?.captureServerEvent ?? defaultCaptureServerEvent;
  // Idempotent: a second call with the same capture is a no-op.
  if (installed === capture) return;
  installed = capture;

  const tracker: ServerSinkTracker = (name, props, userId) => {
    const context = currentTelemetryContext();
    try {
      void Promise.resolve(
        capture({ name, props, userId: userId ?? context.userId, brandKey: context.brandKey }),
      ).catch(() => {});
    } catch {
      // Telemetry must never break email delivery, audits or onboarding.
    }
  };

  setAuditServerTracker(tracker);
  setAuthServerTracker(tracker);
  setEmailEventTracker((name, props) => tracker(name, props ?? {}));
  setOnboardingServerTracker(tracker);
}
