import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AppError } from "../http/appError.ts";
import { runWithTelemetryContext } from "./context.ts";
import { clearConsentCache, clearTelemetryIdCache } from "./privacy.ts";
import {
  captureServerError,
  captureServerEvent,
  isReportableErrorCode,
  serverTelemetryEnabled,
  withoutMessage,
} from "./server.ts";

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/f26/error-with-content.json"), "utf8"),
);

const TELEMETRY_ID = "11111111-2222-4333-8444-555555555555";
const USER_ID = "user-consenting";
const BRAND_KEY = "acme.test";

function fakePosthog() {
  const captures: unknown[] = [];
  const exceptions: Array<{ error: Error; distinctId?: string; props?: unknown }> = [];
  let shutdownThrows = false;
  const client = {
    capture(args: unknown) {
      captures.push(args);
    },
    async captureExceptionImmediate(error: Error, distinctId?: string, props?: unknown) {
      exceptions.push({ error, distinctId, props });
    },
    async shutdown() {
      if (shutdownThrows) throw new Error("shutdown boom");
    },
  };
  return {
    captures,
    exceptions,
    setShutdownThrows(v: boolean) {
      shutdownThrows = v;
    },
    client: () => client,
  };
}

function fakeAdmin({ consent = true as boolean | null, telemetryId = TELEMETRY_ID as string | null } = {}) {
  return {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          if (table === "user_privacy_choices") {
            if (consent === null) return { data: null, error: null };
            return {
              data: {
                analytics: consent,
                decided_at: "2026-10-22T10:00:00.000Z",
                source: "settings",
                policy_version: "2026-10-22",
              },
              error: null,
            };
          }
          if (table === "customer_brands") {
            return {
              data: telemetryId ? { telemetry_id: telemetryId } : null,
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
    },
  };
}

const baseEnv = {
  POSTHOG_PROJECT_KEY: "phc_test",
  POSTHOG_HOST: "https://ph.test",
  TELEMETRY_DISABLED: undefined as string | undefined,
  NODE_ENV: "test",
};

function deps(over: Record<string, unknown> = {}) {
  const ph = fakePosthog();
  clearConsentCache();
  clearTelemetryIdCache();
  return {
    ph,
    deps: {
      env: { ...baseEnv },
      admin: fakeAdmin() as never,
      client: ph.client,
      isFeatureEnabled: async () => true,
      keepAlive: (p: Promise<unknown>) => {
        void p;
      },
      ...over,
    },
  };
}

test("serverTelemetryEnabled requires key and kill switch off", () => {
  assert.equal(serverTelemetryEnabled({}), false);
  assert.equal(serverTelemetryEnabled({ POSTHOG_PROJECT_KEY: "x", TELEMETRY_DISABLED: "1" }), false);
  assert.equal(serverTelemetryEnabled({ POSTHOG_PROJECT_KEY: "x" }), true);
});

test("F26-AC-03 captureServerEvent sends nothing when key missing", async () => {
  const { ph, deps: d } = deps({ env: { ...baseEnv, POSTHOG_PROJECT_KEY: "" } });
  await captureServerEvent(
    { name: "schedule:paused", props: {}, userId: USER_ID, brandKey: BRAND_KEY },
    d as never,
  );
  assert.equal(ph.captures.length, 0);
});

test("F26-AC-03 captureServerEvent sends nothing when TELEMETRY_DISABLED=1", async () => {
  const { ph, deps: d } = deps({ env: { ...baseEnv, TELEMETRY_DISABLED: "1" } });
  await captureServerEvent(
    { name: "schedule:paused", props: {}, userId: USER_ID, brandKey: BRAND_KEY },
    d as never,
  );
  assert.equal(ph.captures.length, 0);
});

test("F26-AC-03 captureServerEvent sends nothing when flag off", async () => {
  const { ph, deps: d } = deps({ isFeatureEnabled: async () => false });
  await captureServerEvent(
    { name: "schedule:paused", props: {}, userId: USER_ID, brandKey: BRAND_KEY },
    d as never,
  );
  assert.equal(ph.captures.length, 0);
});

test("F26-AC-03 captureServerEvent drops invalid props", async () => {
  const { ph, deps: d } = deps();
  const warns: unknown[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a);
  try {
    await captureServerEvent(
      { name: "schedule:paused", props: { surprise: true } as never, userId: USER_ID, brandKey: BRAND_KEY },
      d as never,
    );
  } finally {
    console.warn = real;
  }
  assert.equal(ph.captures.length, 0);
  assert.ok(warns.some((w) => String((w as unknown[])[0]).includes("[telemetry] invalid event")));
});

test("F26-AC-03 captureServerEvent sends nothing without consent for required events", async () => {
  const { ph, deps: d } = deps({ admin: fakeAdmin({ consent: false }) });
  await captureServerEvent(
    { name: "schedule:paused", props: {}, userId: USER_ID, brandKey: BRAND_KEY },
    d as never,
  );
  assert.equal(ph.captures.length, 0);
});

test("F26-AC-03 consented event uses userId and workspace telemetry_id not brand key", async () => {
  const { ph, deps: d } = deps();
  await captureServerEvent(
    { name: "schedule:paused", props: {}, userId: USER_ID, brandKey: BRAND_KEY },
    d as never,
  );
  assert.equal(ph.captures.length, 1);
  const cap = ph.captures[0] as {
    distinctId: string;
    event: string;
    groups?: { workspace?: string };
    properties: Record<string, unknown>;
  };
  assert.equal(cap.distinctId, USER_ID);
  assert.equal(cap.event, "schedule:paused");
  assert.equal(cap.groups?.workspace, TELEMETRY_ID);
  assert.notEqual(cap.groups?.workspace, BRAND_KEY);
  assert.equal(cap.properties.$lib_custom, "perceev-server");
  const blob = JSON.stringify(cap);
  assert.equal(blob.includes(BRAND_KEY), false);
});

test("F26-AC-03 anonymous event uses anon id, no person profile, no groups", async () => {
  const { ph, deps: d } = deps({ admin: fakeAdmin({ consent: null }) });
  await captureServerEvent(
    {
      name: "auth:sign_up_completed",
      props: { method: "email", from_free_scan: false, from_domain: false },
      userId: null,
      brandKey: null,
    },
    d as never,
  );
  assert.equal(ph.captures.length, 1);
  const cap = ph.captures[0] as {
    distinctId: string;
    groups?: unknown;
    properties: Record<string, unknown>;
  };
  assert.match(cap.distinctId, /^anon:/);
  assert.equal(cap.properties.$process_person_profile, false);
  assert.equal(cap.groups, undefined);
});

test("F26-AC-03 context identity used when none passed", async () => {
  const { ph, deps: d } = deps();
  await runWithTelemetryContext({ userId: USER_ID, brandKey: BRAND_KEY }, async () => {
    await captureServerEvent({ name: "schedule:paused", props: {} }, d as never);
  });
  assert.equal(ph.captures.length, 1);
  assert.equal((ph.captures[0] as { distinctId: string }).distinctId, USER_ID);
});

test("F26-AC-04 withoutMessage strips content from message and cause", () => {
  const error = new AppError(500, FIXTURE.code, FIXTURE.message);
  error.cause = new Error(FIXTURE.causeMessage);
  // ensure stack has frames
  try {
    throw error;
  } catch (thrown) {
    const redacted = withoutMessage(thrown);
    assert.match(redacted.stack ?? "", /^AppError: internal_error\n\s+at /);
    assert.equal(/running shoes|acme\.test/.test(redacted.stack ?? ""), false);
    const cause = (redacted as Error & { cause?: Error }).cause;
    assert.ok(cause instanceof Error);
    assert.equal(cause.message, "");
    assert.equal((cause.stack ?? "").includes("acme"), false);
  }
});

test("F26-AC-04 captureServerError skips non-reportable codes", async () => {
  const { ph, deps: d } = deps();
  await captureServerError(new AppError(409, "price_changed", "nope"), { error_code: "price_changed" }, USER_ID, d as never);
  assert.equal(ph.exceptions.length, 0);
  assert.equal(isReportableErrorCode("price_changed"), false);
  assert.equal(isReportableErrorCode("internal_error"), true);
});

test("F26-AC-04 captureServerError never throws when shutdown fails", async () => {
  const { ph, deps: d } = deps();
  ph.setShutdownThrows(true);
  await assert.doesNotReject(() =>
    captureServerError(new Error("boom"), { error_code: "internal_error" }, null, d as never),
  );
  assert.equal(ph.exceptions.length, 1);
  const sent = ph.exceptions[0].error;
  assert.equal(/boom/.test(sent.message), false);
});

