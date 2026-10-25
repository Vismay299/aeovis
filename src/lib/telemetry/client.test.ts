import test from "node:test";
import assert from "node:assert/strict";

function fakePostHog() {
  const calls = {
    init: [] as Array<Record<string, unknown>>,
    capture: [] as Array<{ event: string; properties?: Record<string, unknown> }>,
    opt_in: 0,
    opt_out: 0,
    identify: [] as string[],
    group: [] as Array<[string, string]>,
    reset: 0,
  };
  const client = {
    init(_key: string, opts: Record<string, unknown>) {
      calls.init.push(opts);
    },
    capture(event: string, properties?: Record<string, unknown>) {
      calls.capture.push({ event, properties });
    },
    identify(id: string) {
      calls.identify.push(id);
    },
    group(type: string, id: string) {
      calls.group.push([type, id]);
    },
    reset() {
      calls.reset += 1;
    },
    opt_in_capturing() {
      calls.opt_in += 1;
    },
    opt_out_capturing() {
      calls.opt_out += 1;
    },
    captureException() {},
  };
  return { client, calls };
}

async function loadClient(fake: ReturnType<typeof fakePostHog>) {
  // Fresh module state via dynamic import path — use __resetClientForTests
  const mod = await import("./client.ts");
  mod.__resetClientForTests(async () => fake.client);
  // Ensure env looks configured for default path (loader is injected)
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  delete process.env.NEXT_PUBLIC_TELEMETRY_DISABLED;
  return mod;
}

function waitFor(fn: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timeout"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("F26-AC-05 init options include api_host /ingest, opt-outs, respect_dnt false", async () => {
  const fake = fakePostHog();
  const mod = await loadClient(fake);
  mod.startAnalyticsCapture();
  await waitFor(() => fake.calls.init.length === 1);
  const opts = fake.calls.init[0];
  assert.equal(opts.api_host, "/ingest");
  assert.equal(opts.autocapture, false);
  assert.equal(opts.disable_session_recording, true);
  assert.equal(opts.opt_out_capturing_by_default, true);
  assert.equal(opts.opt_out_persistence_by_default, true);
  assert.equal(opts.respect_dnt, false);
  assert.equal(opts.person_profiles, "identified_only");
  assert.equal(opts.capture_pageview, "history_change");
});

test("F26-AC-05 after consent opt_in_capturing once then queued event reaches capture", async () => {
  const fake = fakePostHog();
  const mod = await loadClient(fake);
  mod.trackEvent("onboarding:step_viewed", { step: 0, step_name: "website" });
  assert.equal(fake.calls.capture.length, 0);
  mod.startAnalyticsCapture();
  await waitFor(() => fake.calls.opt_in === 1 && fake.calls.capture.length === 1);
  assert.equal(fake.calls.opt_in, 1);
  assert.equal(fake.calls.capture[0].event, "onboarding:step_viewed");
  assert.deepEqual(fake.calls.capture[0].properties, { step: 0, step_name: "website" });
});

test("F26-AC-05 buffered events dropped when stop before start flush path", async () => {
  const fake = fakePostHog();
  const mod = await loadClient(fake);
  mod.trackEvent("onboarding:step_viewed", { step: 0, step_name: "website" });
  mod.stopAnalyticsCapture();
  // start after stop with empty buffer (stop nulls buffer)
  mod.startAnalyticsCapture();
  await waitFor(() => fake.calls.opt_in >= 1);
  assert.equal(fake.calls.capture.length, 0);
});

test("F26-AC-05 invalid props never reach capture", async () => {
  const fake = fakePostHog();
  const mod = await loadClient(fake);
  mod.startAnalyticsCapture();
  await waitFor(() => fake.calls.opt_in === 1);
  mod.trackEvent("onboarding:step_viewed", { step: 0, step_name: "website", surprise: 1 } as never);
  // give microtask a turn
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    fake.calls.capture.filter((c) => c.event === "onboarding:step_viewed").length,
    0,
  );
});

test("stopAnalyticsCapture calls opt_out_capturing", async () => {
  const fake = fakePostHog();
  const mod = await loadClient(fake);
  mod.startAnalyticsCapture();
  await waitFor(() => fake.calls.opt_in === 1);
  mod.stopAnalyticsCapture();
  await waitFor(() => fake.calls.opt_out === 1);
});

test("resetTelemetry calls reset", async () => {
  const fake = fakePostHog();
  const mod = await loadClient(fake);
  mod.startAnalyticsCapture();
  await waitFor(() => fake.calls.opt_in === 1);
  mod.resetTelemetry();
  await waitFor(() => fake.calls.reset === 1);
});

test("setTelemetryIdentity groups by workspace telemetry id after start", async () => {
  const fake = fakePostHog();
  const mod = await loadClient(fake);
  mod.setTelemetryIdentity({
    userId: "user-1",
    workspaceTelemetryId: "11111111-2222-4333-8444-555555555555",
  });
  mod.startAnalyticsCapture();
  await waitFor(() => fake.calls.identify.includes("user-1"));
  assert.deepEqual(fake.calls.group[0], ["workspace", "11111111-2222-4333-8444-555555555555"]);
});
