import test from "node:test";
import assert from "node:assert/strict";
import { getQuestionAnswer } from "./answer.ts";

const BRAND_KEY = "offcult.in";
const QUESTION_ID = "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182";
const ANSWER_ID = "6a1f0000-0000-4000-8000-000000000001";
const OBS_ID = "obs-answered-1";
const ATTEMPT = "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5";

const ANSWER_TEXT = "Popular oversized t-shirt brands in India include Bewakoof and the Souled Store for everyday streetwear.";

function makeAdmin(options: {
  link?: Record<string, unknown> | null;
  observation?: Record<string, unknown> | null;
  evidence?: Array<Record<string, unknown>>;
  legacy?: Record<string, unknown> | null;
  windows?: Array<Record<string, unknown>>;
}) {
  const builder = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const api: Record<string, unknown> = {
      select: () => api,
      limit: () => api,
      eq: (col: string, value: unknown) => {
        filters.push((row) => String(row[col]) === String(value));
        return api;
      },
      maybeSingle: async () => {
        if (table === "question_answer_links") return { data: options.link ?? null, error: null };
        if (table === "probe_observations") return { data: options.observation ?? null, error: null };
        if (table === "prompt_results") return { data: options.legacy ?? null, error: null };
        return { data: null, error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        if (table === "measurement_evidence") {
          const rows = (options.evidence ?? []).filter((row) => filters.every((fn) => fn(row)));
          return Promise.resolve({ data: rows, error: null }).then(resolve as never, reject as never);
        }
        if (table === "measurement_windows") {
          const rows = (options.windows ?? []).filter((row) => filters.every((fn) => fn(row)));
          return Promise.resolve({ data: rows, error: null }).then(resolve as never, reject as never);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve as never, reject as never);
      },
    };
    return api;
  };
  return { from: (table: string) => builder(table) } as never;
}

function makeWorkspace(admin: never) {
  return {
    user: { id: "user-1", email: "owner@example.com" },
    brandKey: BRAND_KEY,
    brand: {
      brandKey: BRAND_KEY,
      role: "member" as const,
      display_name: "Offcult",
      website: "https://offcult.in",
      website_host: "offcult.in",
      aliases: ["Offcult"],
      is_active: true,
    },
    role: "member" as const,
    admin: admin as never,
  };
}

function answeredLink() {
  return {
    id: ANSWER_ID,
    question_id: QUESTION_ID,
    brand_key: BRAND_KEY,
    source: "scan",
    observation_id: OBS_ID,
    prompt_result_id: null,
    scan_job_id: "job-1",
    scan_id: "9e8d0000-0000-4000-8000-000000000001",
    explore_run_id: null,
    engine: "chatgpt",
    asked_text: "best oversized t-shirt brands in india",
    collected_at: "2026-10-20T10:12:04.000Z",
  };
}

function answeredObservation() {
  return {
    id: OBS_ID,
    state: "answered",
    reason: null,
    result: {
      text: ANSWER_TEXT,
      answer_present: true,
      brand_mentioned_in_text: false,
      answer_markdown: "Popular **oversized** t-shirt brands in India include **Bewakoof** and the Souled Store.",
      attempt_id: ATTEMPT,
      references: [
        { href: "https://www.bewakoof.com/oversized", title: "Oversized T-shirts", source: "", domain: "bewakoof.com" },
        { href: "javascript:alert(1)", title: "evil", source: "", domain: "" },
      ],
      brands: [
        { name: "Offcult", is_self: true, mentioned: false, cited: false, position: null, relationship: null, sentiment_label: null, spans: [] },
        {
          name: "Bewakoof",
          is_self: false,
          mentioned: true,
          cited: true,
          position: 1,
          relationship: "recommended",
          sentiment_label: "positive",
          spans: [{ start: 50, end: 58 }, { start: 5000, end: 5010 }],
        },
      ],
      entity_evidence: { mentioned: false, mention_state: "observed", spans: [], cited: false },
      brand_cited: false,
      competitors_cited: ["Bewakoof"],
      provenance: {
        method: "model_api",
        gateway: "openrouter",
        requested_model: "openai/gpt-6-luna",
        returned_model: "openai/gpt-6-luna",
        requested_location: "in",
        search_state: "observed_used",
      },
      measurement_method: "model_api",
    },
  };
}

test("answer returns markdown, safe citations, stored spans and evidence href", async () => {
  const admin = makeAdmin({
    link: answeredLink(),
    observation: answeredObservation(),
    evidence: [
      {
        observation_id: OBS_ID,
        attempt_token: ATTEMPT,
        capture_index: 0,
        state: "stored",
        expires_at: "2027-01-18T10:12:04.000Z",
        reason: null,
      },
    ],
  });
  const result = (await getQuestionAnswer(makeWorkspace(admin), QUESTION_ID, ANSWER_ID, {
    trackOpen: () => undefined,
  })) as Record<string, unknown>;
  assert.equal(result.truncated, false);
  assert.ok(String(result.markdown).includes("oversized"));
  const citations = result.citations as Array<Record<string, unknown>>;
  assert.equal(citations.length, 1);
  assert.equal(citations[0].domain, "bewakoof.com");
  assert.equal(citations[0].competitor, "Bewakoof");
  const brands = result.brands as Array<Record<string, unknown>>;
  const rival = brands.find((entry) => entry.name === "Bewakoof") as Record<string, unknown>;
  assert.deepEqual(rival.spans, [{ start: 50, end: 58 }]);
  const evidence = result.evidence as Record<string, unknown>;
  assert.equal(evidence.state, "stored");
  const captures = evidence.captures as Array<Record<string, unknown>>;
  assert.ok(String(captures[0].href).includes("/api/customer/measurement/evidence"));
});

test("answer 404s for another workspace and never leaks provider errors", async () => {
  const admin = makeAdmin({ link: null });
  await assert.rejects(
    () => getQuestionAnswer(makeWorkspace(admin), QUESTION_ID, ANSWER_ID),
    (error: { status?: number; code?: string }) => error.status === 404 && error.code === "answer_not_found",
  );

  const failedAdmin = makeAdmin({
    link: answeredLink(),
    observation: {
      id: OBS_ID,
      state: "failed",
      reason: "provider_error",
      result: {
        text: "",
        attempt_id: ATTEMPT,
        error: "upstream 500 with secret token",
        references: [],
        brands: [],
        entity_evidence: { mentioned: null },
        provenance: {},
      },
    },
    evidence: [],
  });
  const failed = (await getQuestionAnswer(makeWorkspace(failedAdmin), QUESTION_ID, ANSWER_ID)) as Record<string, unknown>;
  assert.equal((failed.execution as Record<string, unknown>).status, "failed");
  assert.equal(failed.error, "Collection failed. This answer was not measured.");
  assert.ok(!JSON.stringify(failed).includes("upstream 500"));
});

test("answer maps withdrawn and expired evidence without an href", async () => {
  for (const [observationId, evidenceRow, expected] of [
    [
      "obs-withdrawn-1",
      {
        observation_id: "obs-withdrawn-1",
        attempt_token: ATTEMPT,
        capture_index: 0,
        state: "stored",
        expires_at: "2027-01-18T10:12:04.000Z",
        reason: "redaction_retracted",
      },
      "withdrawn",
    ],
    [
      "obs-expired-1",
      {
        observation_id: "obs-expired-1",
        attempt_token: ATTEMPT,
        capture_index: 0,
        state: "stored",
        expires_at: "2020-01-01T00:00:00.000Z",
        reason: null,
      },
      "expired",
    ],
  ] as Array<[string, Record<string, unknown>, string]>) {
    const admin = makeAdmin({
      link: { ...answeredLink(), observation_id: observationId },
      observation: { ...answeredObservation(), id: observationId },
      evidence: [evidenceRow],
    });
    const result = (await getQuestionAnswer(makeWorkspace(admin), QUESTION_ID, ANSWER_ID)) as Record<string, unknown>;
    const evidence = result.evidence as Record<string, unknown>;
    assert.equal(evidence.state, expected);
    const captures = evidence.captures as Array<Record<string, unknown>>;
    assert.equal(captures[0].href, null);
  }
});

test("answer text stays the plain text the spans index into when markdown exists", async () => {
  const admin = makeAdmin({ link: answeredLink(), observation: answeredObservation(), evidence: [] });
  const result = (await getQuestionAnswer(makeWorkspace(admin), QUESTION_ID, ANSWER_ID)) as Record<string, unknown>;
  assert.equal(result.text, ANSWER_TEXT);
  assert.ok(String(result.markdown).includes("**Bewakoof**"));
  const rival = (result.brands as Array<Record<string, unknown>>).find((b) => b.name === "Bewakoof") as Record<string, unknown>;
  const [span] = rival.spans as Array<{ start: number; end: number }>;
  assert.equal(String(result.text).slice(span.start, span.end), "Bewakoof");
  const execution = result.execution as Record<string, unknown>;
  assert.equal(execution.engineLabel, "ChatGPT");
  assert.equal(execution.status, "answered");
  assert.equal(execution.trigger, "manual");
  assert.equal((result.evidence as Record<string, unknown>).state, "none");
});

test("answer reads AI Overview rows from aio_text and aio_references", async () => {
  const base = answeredObservation();
  const result0 = base.result as Record<string, unknown>;
  const { text: _t, references: _r, answer_markdown: _m, ...rest } = result0;
  const admin = makeAdmin({
    link: { ...answeredLink(), engine: "aio" },
    observation: {
      ...base,
      result: {
        ...rest,
        aio_text: ANSWER_TEXT,
        aio_references: [{ href: "https://bewakoof.com/x", title: "", source: "", domain: "bewakoof.com" }],
      },
    },
    evidence: [],
  });
  const result = (await getQuestionAnswer(makeWorkspace(admin), QUESTION_ID, ANSWER_ID)) as Record<string, unknown>;
  assert.equal(result.text, ANSWER_TEXT);
  const citations = result.citations as Array<Record<string, unknown>>;
  assert.equal(citations.length, 1);
  assert.equal(citations[0].title, null);
  assert.equal((result.execution as Record<string, unknown>).engineLabel, "Google AI Overviews");
});

test("answer marks a scheduled scan the same way the history list does", async () => {
  const admin = makeAdmin({
    link: answeredLink(),
    observation: answeredObservation(),
    evidence: [],
    windows: [{ job_id: "job-1" }],
  });
  const result = (await getQuestionAnswer(makeWorkspace(admin), QUESTION_ID, ANSWER_ID)) as Record<string, unknown>;
  assert.equal((result.execution as Record<string, unknown>).trigger, "scheduled");
});

test("only an ambiguous result says it may have been charged", async () => {
  for (const [state, expected] of [
    ["ambiguous", "The result of this request is unknown; it may have been charged and will be reconciled."],
    ["pending", null],
    ["leased", null],
  ] as Array<[string, string | null]>) {
    const admin = makeAdmin({
      link: answeredLink(),
      observation: { id: OBS_ID, state, reason: null, result: {} },
      evidence: [],
    });
    const result = (await getQuestionAnswer(makeWorkspace(admin), QUESTION_ID, ANSWER_ID)) as Record<string, unknown>;
    assert.equal(result.error, expected, state);
    assert.equal((result.execution as Record<string, unknown>).status, "unknown");
  }
});

test("a stored capture next to an incomplete one is incomplete, as on the measurement page", async () => {
  const admin = makeAdmin({
    link: answeredLink(),
    observation: answeredObservation(),
    evidence: [
      { observation_id: OBS_ID, attempt_token: ATTEMPT, capture_index: 0, state: "stored", expires_at: "2099-01-01T00:00:00.000Z", reason: null },
      { observation_id: OBS_ID, attempt_token: ATTEMPT, capture_index: 1, state: "pending", expires_at: null, reason: null },
    ],
  });
  const result = (await getQuestionAnswer(makeWorkspace(admin), QUESTION_ID, ANSWER_ID)) as Record<string, unknown>;
  const evidence = result.evidence as { state: string; captures: Array<{ href: string | null }> };
  assert.equal(evidence.state, "incomplete");
  assert.ok(evidence.captures[0].href);
  assert.equal(evidence.captures[1].href, null);
});
