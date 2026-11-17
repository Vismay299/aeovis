import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SERP_GEO,
  DEFAULT_LANGUAGE,
  DEFAULT_DEVICE,
  DEFAULT_SESSION_POLICY,
  SUPPORTED_COUNTRIES,
  ADAPTER_CAPABILITIES,
  resolveMeasurementContext,
  buildAdapterContextParams,
  buildObservationContextKey,
  qualifyLocationAttestation,
  assertContextComparability,
  handleProviderFallback,
  resumeCheckpointContext,
} from "../../shared/engines/serpGeo.js";

test("R10-01 — Valid India context resolves to explicit stored 'in' plus language/surface policy with no missing identity dimensions (U)", () => {
  const ctx = resolveMeasurementContext({ country: "in" });

  assert.equal(ctx.country, "in");
  assert.equal(ctx.language, DEFAULT_LANGUAGE);
  assert.equal(ctx.device, DEFAULT_DEVICE);
  assert.equal(ctx.session_policy, DEFAULT_SESSION_POLICY);
  assert.ok(ctx.surface);
});

test("R10-02 — Valid non-India context retains user selection with no unconditional India override (U)", () => {
  const ctx = resolveMeasurementContext({ country: "us", language: "en", device: "mobile" });

  assert.equal(ctx.country, "us");
  assert.equal(ctx.language, "en");
  assert.equal(ctx.device, "mobile");
  assert.equal(ctx.user_selected, true);
  assert.notEqual(ctx.country, "in");
});

test("R10-03 — Invalid or blank country/language validates to documented default or explicit rejection (U)", () => {
  // Invalid country code throws explicit error
  assert.throws(
    () => resolveMeasurementContext({ country: "xyz_invalid" }),
    /Unsupported or invalid country code "xyz_invalid"/
  );

  // Blank language resolves to documented default
  const ctxWithBlankLang = resolveMeasurementContext({ country: "in", language: "" });
  assert.equal(ctxWithBlankLang.language, DEFAULT_LANGUAGE);
});

test("R10-04 — Non-India Google observation outgoing request matches frozen country/language/device parameters (I)", () => {
  const context = { country: "us", language: "en", device: "mobile" };
  const params = buildAdapterContextParams("aio", context);

  assert.equal(params.country, "us");
  assert.equal(params.gl, "us");
  assert.equal(params.hl, "en");
  assert.equal(params.device, "mobile");
});

test("R10-05 — Non-India ChatGPT direct and gateway capture requests reflect actual adapter capabilities (I)", () => {
  const context = { country: "sg" };

  // Gateway path supports approximate country location
  const gatewayParams = buildAdapterContextParams("chatgpt", context, "gateway");
  assert.deepEqual(gatewayParams.user_location, {
    type: "approximate",
    country: "SG",
  });

  // Direct path lacks location control; preserves requested without fabricating support
  const directParams = buildAdapterContextParams("chatgpt", context, "direct");
  assert.equal(directParams.unsupported_location_control, true);
  assert.equal(directParams.requested_country, "sg");
});

test("R10-06 — Native Sonar branch marks location control unsupported rather than labeling unverified India (I)", () => {
  const context = { country: "in" };
  const sonarParams = buildAdapterContextParams("perplexity", context, "sonar");

  assert.equal(sonarParams.unsupported_location_control, true);
  assert.equal(sonarParams.requested_country, "in");
  assert.equal(ADAPTER_CAPABILITIES.perplexity_sonar.countryControl, false);
});

test("R10-07 — Gateway ignoring location control leaves observed context unverified rather than assumed equal (I)", () => {
  const requestedContext = { country: "in" };
  // When gateway returns response without verified egress location
  const qualification = qualifyLocationAttestation(requestedContext, null);

  assert.equal(qualification.verified, false);
  assert.equal(qualification.state, "unverified");
  assert.match(qualification.label, /location unverified/i);
});

test("R10-08 — Device and session policy differences build distinct observation keys and comparison cohorts (U)", () => {
  const keyDesktop = buildObservationContextKey({ country: "in", device: "desktop", session_policy: "fresh_anonymous" });
  const keyMobile = buildObservationContextKey({ country: "in", device: "mobile", session_policy: "fresh_anonymous" });
  const keyFixed = buildObservationContextKey({ country: "in", device: "desktop", session_policy: "fixed_session" });

  assert.notEqual(keyDesktop, keyMobile);
  assert.notEqual(keyDesktop, keyFixed);

  // Incompatible comparison throws
  assert.throws(
    () => assertContextComparability({ country: "in", device: "desktop" }, { country: "in", device: "mobile" }),
    /Incompatible measurement comparison: device/
  );
});

test("R10-09 — Resuming after checkpoint uses original frozen context even if deployment defaults change (I)", () => {
  const checkpoint = {
    observation_id: "obs-101",
    measurement_context: {
      country: "in",
      language: "en",
      device: "desktop",
    },
  };

  // Environment changed to US defaults
  const newEnv = { SERP_GEO: "us" };
  const resumedContext = resumeCheckpointContext(checkpoint, newEnv);

  assert.equal(resumedContext.country, "in");
  assert.notEqual(resumedContext.country, "us");
});

test("R10-10 — India provider failure with US fallback available rejects silent US substitution (I)", () => {
  const requestedIndia = { country: "in" };
  const fallbackUS = { country: "us" };

  assert.throws(
    () => handleProviderFallback(requestedIndia, fallbackUS),
    /Silent market substitution blocked/
  );
});

test("R10-12 — Requested and observed countries disagreement triggers mismatch flag and prevents verified claim (U)", () => {
  const requested = { country: "in" };
  const observedUS = { country: "us" };

  const qualification = qualifyLocationAttestation(requested, observedUS);

  assert.equal(qualification.verified, false);
  assert.equal(qualification.mismatch, true);
  assert.equal(qualification.state, "mismatch");
  assert.match(qualification.label, /Location mismatch/);
});
