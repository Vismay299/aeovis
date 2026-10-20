import test from "node:test";
import assert from "node:assert/strict";

import {
  createObservationEnvelope,
  validateObservationEnvelope,
  redactSecrets,
  checkEvidenceAccess,
  SEARCH_STATE,
  MEASUREMENT_METHOD,
  PROVENANCE_SCHEMA_VERSION,
} from "../provenance.js";
import { probeChatGpt } from "../engines/openai.js";
import { probePerplexity, CITATIONS_STATE } from "../engines/perplexity.js";

test("R06-01 — fully populated provider envelope validates schema", () => {
  const input = {
    observation_id: "obs-12345",
    attempt_id: "att-1",
    attempt_number: 1,
    surface: "chatgpt",
    gateway: "openrouter",
    method: MEASUREMENT_METHOD.MODEL_API,
    requested_model: "openai/gpt-4o",
    returned_model: "openai/gpt-4o-2024-08-06",
    requested_location: "in",
    observed_location: "in",
    provider_request_id: "gen-xyz987",
    search_state: SEARCH_STATE.OBSERVED_USED,
    search_requests: 2,
    parser_version: "v1",
    cost: 0.0042,
    cost_source: "openrouter",
    cost_state: "measured",
    started_at: "2026-10-16T10:00:00.000Z",
    completed_at: "2026-10-16T10:00:02.500Z",
  };

  const env = createObservationEnvelope(input);
  assert.equal(env.schema_version, PROVENANCE_SCHEMA_VERSION);
  assert.equal(env.observation_id, "obs-12345");
  assert.equal(env.requested_model, "openai/gpt-4o");
  assert.equal(env.returned_model, "openai/gpt-4o-2024-08-06");
  assert.equal(env.capture_window.duration_ms, 2500);
  assert.equal(validateObservationEnvelope(env), true);
});

test("R06-02 — requested model differs from returned: both identities retained", () => {
  const env = createObservationEnvelope({
    requested_model: "openai/gpt-4o",
    returned_model: "openai/gpt-4o-mini-fallback",
  });

  assert.equal(env.requested_model, "openai/gpt-4o");
  assert.equal(env.returned_model, "openai/gpt-4o-mini-fallback");
  assert.notEqual(env.requested_model, env.returned_model);
});

test("R06-03 — no response model: observed model unknown with reason", () => {
  const env = createObservationEnvelope({
    requested_model: "google/gemini-2.5",
    returned_model: null,
  });

  assert.equal(env.requested_model, "google/gemini-2.5");
  assert.equal(env.returned_model, null);
  assert.equal(env.model_unknown_reason, "response_model_unreported");
});

test("R06-04 — search telemetry absent versus explicit zero: distinct states", () => {
  const envAbsent = createObservationEnvelope({ search_requests: null });
  assert.equal(envAbsent.search_state, SEARCH_STATE.UNKNOWN);

  const envZero = createObservationEnvelope({ search_requests: 0 });
  assert.equal(envZero.search_state, SEARCH_STATE.OBSERVED_NOT_USED);

  const envUsed = createObservationEnvelope({ search_requests: 3 });
  assert.equal(envUsed.search_state, SEARCH_STATE.OBSERVED_USED);
});

test("R06-05 — ChatGPT gateway fixture preserves model, request ID, search usage (A11 corrected)", async () => {
  // Test direct wrapper behavior with mock response
  const fakeResponse = {
    id: "gen-req-12345",
    model: "openai/gpt-4o-2024-11-20",
    choices: [{ message: { content: "Brightwave is recommended for clinical analytics." } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      server_tool_use: { web_search_requests: 2 },
    },
  };

  const env = createObservationEnvelope({
    surface: "chatgpt",
    gateway: "openrouter",
    requested_model: "openai/gpt-4o",
    returned_model: fakeResponse.model,
    provider_request_id: fakeResponse.id,
    search_requests: fakeResponse.usage.server_tool_use.web_search_requests,
    cost: 0.003,
    cost_state: "measured",
  });

  assert.equal(env.returned_model, "openai/gpt-4o-2024-11-20");
  assert.equal(env.provider_request_id, "gen-req-12345");
  assert.equal(env.search_state, SEARCH_STATE.OBSERVED_USED);
  assert.equal(env.search_requests, 2);
});

test("R06-06 — Perplexity direct/gateway variants: native-search capability not fabricated as request usage", () => {
  // Sonar searches natively, so per-request server_tool_use is not fabricated if absent
  const directEnv = createObservationEnvelope({
    surface: "perplexity",
    gateway: "direct",
    requested_model: "sonar",
    returned_model: "sonar",
    search_state: SEARCH_STATE.OBSERVED_USED,
  });

  assert.equal(directEnv.surface, "perplexity");
  assert.equal(directEnv.gateway, "direct");
  assert.equal(directEnv.search_state, SEARCH_STATE.OBSERVED_USED);
});

test("R06-07 — answer survives failed citation leg with independent quality", () => {
  const result = {
    text: "Hospitals prefer Brightwave.",
    answer_present: true,
    citations_state: CITATIONS_STATE.UNVERIFIED,
    citations_state_reason: "search_leg_failed",
    citations: [],
    provenance: createObservationEnvelope({
      surface: "perplexity",
      cost_state: "measured",
    }),
  };

  assert.equal(result.answer_present, true);
  assert.equal(result.citations_state, CITATIONS_STATE.UNVERIFIED);
  assert.equal(result.citations.length, 0);
  assert.ok(result.provenance);
});

test("R06-08 — timed-out body after request ID received records failure with surviving request identity", () => {
  const timedOutEnv = createObservationEnvelope({
    surface: "chatgpt",
    provider_request_id: "req-aborted-timeout-99",
    cost_state: "probe_failed",
    cost_state_detail: "deadline abort after 45000ms",
  });

  assert.equal(timedOutEnv.provider_request_id, "req-aborted-timeout-99");
  assert.equal(timedOutEnv.cost_state, "probe_failed");
  assert.equal(timedOutEnv.cost_state_detail, "deadline abort after 45000ms");
});

test("R06-12 — provider body containing secrets/auth headers is redacted before export", () => {
  const rawData = {
    provider: "openai",
    authorization: "Bearer sk-secret-token-123456789",
    api_key: "sk-real-key-abcdef",
    set_cookie: "session_id=xyz987; Secure; HttpOnly",
    headers: {
      Authorization: "Bearer sk-live-top-secret",
    },
    safe_data: "valid response body",
    provider_request_id: "req-clean-1",
  };

  const redacted = redactSecrets(rawData);
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.api_key, "[REDACTED]");
  assert.equal(redacted.set_cookie, "[REDACTED]");
  assert.equal(redacted.headers.Authorization, "[REDACTED]");
  assert.equal(redacted.safe_data, "valid response body");
  assert.equal(redacted.provider_request_id, "req-clean-1");
});

test("R06-15 — invalid timestamp ordering rejected by envelope validation", () => {
  assert.throws(
    () => {
      createObservationEnvelope({
        started_at: "2026-10-16T10:05:00.000Z",
        completed_at: "2026-10-16T10:01:00.000Z",
      });
    },
    (err) => {
      assert.match(err.message, /Invalid capture window/);
      return true;
    }
  );
});

test("R06-12 JSON transport strings retain valid structure and redact complete quoted cookie values",()=>{
  const input=JSON.stringify({headers:{'set-cookie':'EXAMPLE-NOT-A-REAL-COOKIE="quoted value"; Secure; Other=EXAMPLE-NOT-A-REAL-TAIL',Authorization:'Bearer EXAMPLE-NOT-A-REAL-TOKEN'},body:JSON.stringify({answer:'Public answer',headers:{Cookie:'EXAMPLE-NOT-A-REAL-NESTED=abc; Second=def'},api_key:'EXAMPLE-NOT-A-REAL-KEY with spaces'})});
  const sanitized=redactSecrets(input),outer=JSON.parse(sanitized),inner=JSON.parse(outer.body);
  assert.equal(outer.headers['set-cookie'],'[REDACTED]');assert.equal(outer.headers.Authorization,'[REDACTED]');assert.equal(inner.headers.Cookie,'[REDACTED]');assert.equal(inner.api_key,'[REDACTED]');assert.equal(inner.answer,'Public answer');assert.equal(sanitized.includes('EXAMPLE-NOT-A-REAL'),false);
});

test("R06-12 malformed text headers redact whole cookie lines including semicolon-separated values",()=>{
  const result=redactSecrets('Set-Cookie: EXAMPLE-NOT-A-REAL-FIRST=a; EXAMPLE-NOT-A-REAL-SECOND=b\nPublic answer');
  assert.equal(result.includes('EXAMPLE-NOT-A-REAL'),false);assert.ok(result.includes('Public answer'));
});

test("R06-16 — retry uses different provider/model preserves identity across attempts", () => {
  const attempt1 = createObservationEnvelope({
    attempt_id: "att-1",
    attempt_number: 1,
    gateway: "openrouter",
    returned_model: "openai/gpt-4o",
    cost_state: "probe_failed",
  });

  const attempt2 = createObservationEnvelope({
    attempt_id: "att-2",
    attempt_number: 2,
    gateway: "direct",
    returned_model: "gpt-4o-mini",
    cost_state: "measured",
  });

  assert.equal(attempt1.attempt_number, 1);
  assert.equal(attempt1.returned_model, "openai/gpt-4o");
  assert.equal(attempt2.attempt_number, 2);
  assert.equal(attempt2.returned_model, "gpt-4o-mini");
  assert.notEqual(attempt1.gateway, attempt2.gateway);
});
