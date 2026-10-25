import assert from "node:assert/strict";
import { test } from "node:test";
import { createDataforseoBillingClassifier } from "./billingClassification.ts";
import { AppError } from "../../http/appError.ts";
import {
  AmbiguousCallError,
  UnbilledCallError,
} from "../../spend/errors.ts";
import {
  DATAFORSEO_API_BASE,
  DATAFORSEO_SANDBOX_BASE,
  dataforseoGet,
  dataforseoPost,
} from "./core.ts";

function okResponse(): Response {
  return Response.json({ status_code: 20000, tasks: [] });
}

test("missing key fails before fetching and Authorization carries Basic credentials", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return okResponse();
  };
  await assert.rejects(
    dataforseoPost("/v3/example/live", [], { env: {}, fetchImpl }),
    (error: unknown) =>
      error instanceof AppError &&
      error.status === 503 &&
      error.code === "dataforseo_not_configured",
  );
  assert.equal(calls, 0);

  let authorization: string | null = null;
  await dataforseoPost("/v3/example/live", [], {
    env: { DATAFORSEO_API_KEY: "encoded-credentials" },
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return okResponse();
    },
  });
  assert.equal(authorization, "Basic encoded-credentials");
});

test("only the API and sandbox base URLs are accepted", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return okResponse();
  };
  await assert.rejects(
    dataforseoGet("/v3/example", {
      env: { DATAFORSEO_API_KEY: "key" },
      baseUrl: "https://attacker.example",
      fetchImpl,
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.status === 500 &&
      error.code === "dataforseo_base_url_invalid",
  );
  assert.equal(calls, 0);

  for (const baseUrl of [DATAFORSEO_API_BASE, DATAFORSEO_SANDBOX_BASE]) {
    await dataforseoGet("/v3/example", {
      env: { DATAFORSEO_API_KEY: "key" },
      baseUrl,
      fetchImpl,
    });
  }
  assert.equal(calls, 2);
});

test("POST never retries an HTTP 503 and reports an ambiguous billed outcome", async () => {
  let calls = 0;
  await assert.rejects(
    dataforseoPost("/v3/example/live", [], {
      env: { DATAFORSEO_API_KEY: "key" },
      fetchImpl: async () => {
        calls += 1;
        return new Response("upstream failure", { status: 503 });
      },
    }),
    AmbiguousCallError,
  );
  assert.equal(calls, 1);
});

test("POST 429 is not retried and is classified unbilled", async () => {
  let calls = 0;
  await assert.rejects(
    dataforseoPost("/v3/example/live", [], {
      env: { DATAFORSEO_API_KEY: "key" },
      fetchImpl: async () => {
        calls += 1;
        return new Response("rate limited", { status: 429 });
      },
    }),
    UnbilledCallError,
  );
  assert.equal(calls, 1);
});

test("POST timeout is ambiguous and sent exactly once", async () => {
  let calls = 0;
  await assert.rejects(
    dataforseoPost("/v3/example/live", [], {
      env: { DATAFORSEO_API_KEY: "key" },
      timeoutMs: 10,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      },
    }),
    AmbiguousCallError,
  );
  assert.equal(calls, 1);
});

test("GET retries two 5xx failures with backoff and returns the third response", async () => {
  let calls = 0;
  const result = await dataforseoGet("/v3/example", {
    env: { DATAFORSEO_API_KEY: "key" },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return new Response("upstream failure", { status: 503 });
      return Response.json({ status_code: 20000, tasks: [] });
    },
  });
  assert.equal(calls, 3);
  assert.equal(result?.status_code, 20000);
});

test("GET 5xx after its retry budget is a free AppError", async () => {
  let calls = 0;
  await assert.rejects(
    dataforseoGet("/v3/example", {
      env: { DATAFORSEO_API_KEY: "key" },
      fetchImpl: async () => {
        calls += 1;
        return new Response("upstream failure", { status: 503 });
      },
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.status === 503 &&
      error.code === "dataforseo_unavailable",
  );
  assert.equal(calls, 3);
});

test("HTTP refusal rows classify as unbilled for both request methods and call once", async () => {
  for (const method of ["GET", "POST"] as const) {
    for (const status of [401, 402, 429, 400, 403, 404]) {
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls += 1;
        return new Response("provider refusal", { status });
      };
      const request = method === "GET"
        ? dataforseoGet("/v3/example", { env: { DATAFORSEO_API_KEY: "key" }, fetchImpl })
        : dataforseoPost("/v3/example/live", [], { env: { DATAFORSEO_API_KEY: "key" }, fetchImpl });
      await assert.rejects(request, UnbilledCallError);
      assert.equal(calls, 1, method + " HTTP " + status);
    }
  }
});

test("GET abort is free and invalid JSON is a bad response", async () => {
  let timeoutCalls = 0;
  await assert.rejects(
    dataforseoGet("/v3/example", {
      env: { DATAFORSEO_API_KEY: "key" },
      fetchImpl: async () => {
        timeoutCalls += 1;
        throw Object.assign(new Error("timed out"), { name: "AbortError" });
      },
    }),
    (error: unknown) => error instanceof AppError && error.status === 503 && error.code === "dataforseo_unavailable",
  );
  assert.equal(timeoutCalls, 1);

  let getCalls = 0;
  await assert.rejects(
    dataforseoGet("/v3/example", {
      env: { DATAFORSEO_API_KEY: "key" },
      fetchImpl: async () => { getCalls += 1; return new Response("{", { status: 200 }); },
    }),
    (error: unknown) => error instanceof AppError && error.status === 502 && error.code === "dataforseo_bad_response",
  );
  assert.equal(getCalls, 1);

  let postCalls = 0;
  await assert.rejects(
    dataforseoPost("/v3/example/live", [], {
      env: { DATAFORSEO_API_KEY: "key" },
      fetchImpl: async () => { postCalls += 1; return new Response("{", { status: 200 }); },
    }),
    AmbiguousCallError,
  );
  assert.equal(postCalls, 1);
});

test("built billing classifier recognizes 40200, 40210, HTTP 402, and billing words", () => {
  const classify = createDataforseoBillingClassifier({
    pathPrefix: "/v3/ai_optimization",
    billingIssueCode: "dataforseo_balance",
    billingIssueMessage: "DataForSEO balance issue",
  });
  const endpoint = "/v3/ai_optimization/chat_gpt/llm_responses/live";
  for (const status of [40200, 40210, 402]) {
    const error = classify(status, "Provider rejected request", endpoint);
    assert.ok(error instanceof UnbilledCallError);
    assert.equal(error.message, "DataForSEO balance issue");
  }
  assert.ok(classify(40000, "Payment required for this account", endpoint) instanceof UnbilledCallError);
  assert.equal(classify(40200, "Account balance is too low", "/v3/serp/google/organic/live"), null);
});
