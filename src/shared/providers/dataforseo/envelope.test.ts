// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/envelope.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDataforseoBillingClassifier } from "./billingClassification.ts";
import { toErrorResponse } from "../../http/errors.ts";
import { z } from "zod";
import {
  assertOk,
  isNoResultsTask,
  isTaskInProgress,
  isUpstreamFailureStatus,
  parseTaskItems,
} from "./envelope.ts";
import {
  AmbiguousCallError,
  ChargedCallError,
  UnbilledCallError,
} from "../../spend/errors.ts";

const itemSchema = z.looseObject({ keyword: z.string().optional() });

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail("expected assertOk to throw");
}

async function assertErrorResponse(
  error: unknown,
  expected: { status: number; code: string; details?: Record<string, unknown> },
): Promise<void> {
  const response = toErrorResponse(error);
  assert.equal(response.status, expected.status);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, expected.code);
  assert.equal(typeof body.error, "string");
  if (expected.details === undefined) {
    assert.equal("details" in body, false);
  } else {
    assert.deepEqual(body.details, expected.details);
  }
}

test("parseTaskItems returns [] when the task has no item array", () => {
  assert.deepEqual(parseTaskItems("x", { result: [{ items: null }] }, itemSchema), []);
  assert.deepEqual(parseTaskItems("x", { result: undefined }, itemSchema), []);
});

test("charged task failures preserve the provider cost", () => {
  assert.throws(
    () =>
      assertOk({
        status_code: 20000,
        tasks: [{
          status_code: 40000,
          status_message: "Task failed",
          path: ["v3", "backlinks", "summary", "live"],
          cost: 0.05,
        }],
      }),
    (error: unknown) =>
      error instanceof ChargedCallError &&
      error.actualUsd === 0.05 &&
      error.provider === "dataforseo" &&
      error.endpoint === "/v3/backlinks/summary/live",
  );
});

test("top-level 50000 and backend task failures remain identifiable as upstream status codes", () => {
  assert.equal(isUpstreamFailureStatus(50000), true);
  assert.throws(
    () => assertOk({ status_code: 50000, status_message: "Internal Server Error" }),
    UnbilledCallError,
  );
  assert.equal(isUpstreamFailureStatus(50100), false);
  assert.equal(isUpstreamFailureStatus(40101), true);
});

test("billing classifier runs before charged task classification", () => {
  let calls = 0;
  const classify = (status: number | undefined, details: string, path: string) => {
    calls += 1;
    assert.equal(status, 40200);
    assert.equal(details, "Account balance is too low");
    assert.equal(path, "/v3/ai_optimization/chat_gpt/llm_responses/live");
    return new UnbilledCallError("UPSTREAM_SENTINEL " + details);
  };
  assert.throws(
    () =>
      assertOk(
        {
          status_code: 20000,
          tasks: [{
            status_code: 40200,
            status_message: "Account balance is too low",
            path: ["v3", "ai_optimization", "chat_gpt", "llm_responses", "live"],
            cost: 0.05,
          }],
        },
        { classify, classifyPath: "/v3/ai_optimization/chat_gpt/llm_responses/live" },
      ),
    (error: unknown) => error instanceof UnbilledCallError && error.message === "The DataForSEO account has a billing or balance issue.",
  );
  assert.equal(calls, 1);
});

test("40501 No Search Results is an empty success only when allowed", () => {
  const task = {
    status_code: 40501,
    status_message: "No Search Results",
    path: ["v3", "serp", "google", "organic", "live", "advanced"],
    cost: 0,
  };
  assert.equal(
    assertOk({ status_code: 20000, tasks: [task] }, { treatNoResultsAsEmpty: true }),
    task,
  );
  assert.throws(
    () => assertOk({ status_code: 20000, tasks: [task] }),
    (error: unknown) => error instanceof ChargedCallError && error.actualUsd === 0,
  );
});

test("No Search Results text counts as empty only with a no-results status code", () => {
  const path = ["v3", "serp", "google", "organic", "live", "advanced"];
  const documented = { status_code: 40102, status_message: "No Search Results.", path, cost: 0.002 };
  assert.equal(isNoResultsTask(documented), true);
  assert.equal(
    assertOk({ status_code: 20000, tasks: [documented] }, { treatNoResultsAsEmpty: true }),
    documented,
  );
  for (const status_code of [40000, 50000, 40400]) {
    assert.equal(isNoResultsTask({ status_code, status_message: "No Search Results", path, cost: 0 }), false);
  }
});

test("a charged 40501 Invalid Field still surfaces with its cost", () => {
  const task = {
    status_code: 40501,
    status_message: "Invalid Field: 'categories'.",
    path: ["v3", "business_data", "business_listings", "search", "live"],
    cost: 0.02,
    data: { categories: ["example"] },
  };
  assert.throws(
    () => assertOk({ status_code: 20000, tasks: [task] }, { treatNoResultsAsEmpty: true }),
    (error: unknown) =>
      error instanceof ChargedCallError &&
      error.actualUsd === 0.02 &&
      error.endpoint === "/v3/business_data/business_listings/search/live",
  );
});

test("Invalid Field with zero cost is unbilled", () => {
  assert.throws(
    () =>
      assertOk({
        status_code: 20000,
        tasks: [{
          status_code: 40501,
          status_message: "Invalid Field: 'model_name'.",
          path: ["v3", "ai_optimization", "chat_gpt", "llm_responses", "live"],
          cost: 0,
        }],
      }),
    UnbilledCallError,
  );
});

test("task failure with no billing metadata is ambiguous", () => {
  assert.throws(
    () =>
      assertOk({
        status_code: 20000,
        tasks: [{ status_code: 40000, status_message: "unknown task outcome" }],
      }),
    AmbiguousCallError,
  );
});

test("20100, 40601, and 40602 are pending task statuses", () => {
  for (const status_code of [20100, 40601, 40602]) {
    assert.equal(isTaskInProgress({ status_code }), true);
  }
  assert.equal(isTaskInProgress({ status_code: 20000 }), false);
});

test("all documented upstream task codes match the explicit allowlist", () => {
  for (const status_code of [40101, 40103, 50000, 50301, 50302, 50303, 50304, 50401, 50402]) {
    assert.equal(isUpstreamFailureStatus(status_code), true);
  }
  for (const status_code of [50001, 50100, 40501]) {
    assert.equal(isUpstreamFailureStatus(status_code), false);
  }
});

test("?6.2.2 task rows classify by billing metadata and invalid-field state", () => {
  const path = ["v3", "ai_optimization", "chat_gpt", "llm_responses", "live"];
  const endpoint = "/" + path.join("/");
  const classify = createDataforseoBillingClassifier({
    pathPrefix: "/v3/ai_optimization",
    billingIssueCode: "dataforseo_balance",
    billingIssueMessage: "DataForSEO balance issue",
  });

  for (const status_code of [40200, 40210]) {
    assert.throws(
      () => assertOk({
        status_code: 20000,
        tasks: [{ status_code, status_message: "Provider billing failure", path, cost: 0.05 }],
      }, { classify, classifyPath: endpoint }),
      (error: unknown) => error instanceof UnbilledCallError && error.message === "The DataForSEO account has a billing or balance issue.",
    );
  }
  assert.throws(
    () => assertOk({ status_code: 40200, status_message: "Account balance too low" }, { classify, classifyPath: endpoint }),
    (error: unknown) => error instanceof UnbilledCallError && error.message === "The DataForSEO account has a billing or balance issue.",
  );
  assert.throws(
    () => assertOk({ status_code: 40000, status_message: "Payment required" }, { classify, classifyPath: endpoint }),
    (error: unknown) => error instanceof UnbilledCallError && error.message === "The DataForSEO account has a billing or balance issue.",
  );

  const taskRows: Array<{ task: Record<string, unknown>; matches: (error: unknown) => boolean }> = [
    {
      task: { status_code: 40101, status_message: "backend task failure", path, cost: 0.05 },
      matches: (error) => error instanceof ChargedCallError && error.actualUsd === 0.05,
    },
    {
      task: { status_code: 40101, status_message: "backend task failure", path, cost: 0 },
      matches: (error) => error instanceof ChargedCallError && error.actualUsd === 0,
    },
    {
      task: { status_code: 40501, status_message: "Invalid Field: 'model_name'.", path, cost: 0 },
      matches: (error) => error instanceof UnbilledCallError,
    },
    {
      task: { status_code: 40000, status_message: "task outcome unknown" },
      matches: (error) => error instanceof AmbiguousCallError,
    },
  ];
  for (const row of taskRows) {
    assert.throws(() => assertOk({ status_code: 20000, tasks: [row.task] }), row.matches);
  }

  const noResults = { status_code: 40501, status_message: "No Search Results", path, cost: 0 };
  assert.equal(assertOk({ status_code: 20000, tasks: [noResults] }, { treatNoResultsAsEmpty: true }), noResults);
  assert.throws(
    () => assertOk({ status_code: 50000, status_message: "backend unavailable" }),
    UnbilledCallError,
  );
});

test("§6.2.2 top-level status and billing-classifier errors serialize safe metadata", async () => {
  const path = "/v3/ai_optimization/chat_gpt/llm_responses/live";
  const classify = createDataforseoBillingClassifier({
    pathPrefix: "/v3/ai_optimization",
    billingIssueCode: "dataforseo_balance",
    billingIssueMessage: "DataForSEO balance issue",
  });

  for (const status_code of [40200, 40210]) {
    const error = captureError(() => assertOk({
      status_code,
      status_message: "UPSTREAM_SENTINEL billing account details",
    }, { classify, classifyPath: path }));
    assert.ok(error instanceof UnbilledCallError);
    assert.equal(error.message, "The DataForSEO account has a billing or balance issue.");
    assert.equal(error.message.includes("UPSTREAM_SENTINEL"), false);
    await assertErrorResponse(error, {
      status: 402,
      code: "dataforseo_balance",
      details: { providerCode: `dataforseo_${status_code}` },
    });
    assert.equal((await toErrorResponse(error).text()).includes("UPSTREAM_SENTINEL"), false);
  }

  const billingWords = captureError(() => assertOk({
    status_code: 40000,
    status_message: "UPSTREAM_SENTINEL Payment required for this account",
  }, { classify, classifyPath: path }));
  assert.ok(billingWords instanceof UnbilledCallError);
  await assertErrorResponse(billingWords, {
    status: 402,
    code: "dataforseo_balance",
    details: { providerCode: "dataforseo_40000" },
  });
  assert.equal((await toErrorResponse(billingWords).text()).includes("UPSTREAM_SENTINEL"), false);

  const requestFailure = captureError(() => assertOk({
    status_code: 50000,
    status_message: "UPSTREAM_SENTINEL internal response",
  }));
  assert.ok(requestFailure instanceof UnbilledCallError);
  await assertErrorResponse(requestFailure, {
    status: 502,
    code: "dataforseo_request_failed",
    details: { statusCode: 50000, providerCode: "dataforseo_50000" },
  });
  assert.equal((await toErrorResponse(requestFailure).text()).includes("UPSTREAM_SENTINEL"), false);
});

test("§6.2.2 task status × cost outcomes keep AppError mapping and never serialize upstream text", async () => {
  const path = ["v3", "ai_optimization", "chat_gpt", "llm_responses", "live"];
  const endpoint = "/" + path.join("/");
  const classify = createDataforseoBillingClassifier({
    pathPrefix: "/v3/ai_optimization",
    billingIssueCode: "dataforseo_balance",
    billingIssueMessage: "DataForSEO balance issue",
  });
  const rows: Array<{
    task: Record<string, unknown>;
    classify?: boolean;
    verify: (error: unknown) => void;
    response: { status: number; code: string; details?: Record<string, unknown> };
  }> = [
    {
      task: { status_code: 40101, status_message: "UPSTREAM_SENTINEL backend failure", path, cost: 0.05 },
      verify: (error) => {
        assert.ok(error instanceof ChargedCallError);
        assert.equal(error.actualUsd, 0.05);
        assert.equal(error.status, 502);
        assert.equal(error.code, "dataforseo_task_failed");
        assert.equal(error.message.includes("UPSTREAM_SENTINEL"), false);
      },
      response: { status: 502, code: "dataforseo_task_failed", details: { upstream: true, providerCode: "dataforseo_40101" } },
    },
    {
      task: { status_code: 40000, status_message: "UPSTREAM_SENTINEL failed", path, cost: 0 },
      verify: (error) => {
        assert.ok(error instanceof ChargedCallError);
        assert.equal(error.actualUsd, 0);
        assert.equal(error.status, 502);
        assert.equal(error.code, "dataforseo_task_failed");
      },
      response: { status: 502, code: "dataforseo_task_failed", details: { upstream: false, providerCode: "dataforseo_40000" } },
    },
    {
      task: { status_code: 40501, status_message: "Invalid Field: 'model_name'. UPSTREAM_SENTINEL", path, cost: 0 },
      verify: (error) => {
        assert.ok(error instanceof UnbilledCallError);
        assert.equal(error.status, 422);
        assert.equal(error.code, "dataforseo_invalid_field");
        assert.equal(error.message.includes("UPSTREAM_SENTINEL"), false);
      },
      response: { status: 422, code: "dataforseo_invalid_field", details: { field: "model_name", providerCode: "dataforseo_40501" } },
    },
    {
      task: { status_code: 40000, status_message: "UPSTREAM_SENTINEL outcome unknown" },
      verify: (error) => {
        assert.ok(error instanceof AmbiguousCallError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "dataforseo_task_failed");
      },
      response: { status: 502, code: "dataforseo_task_failed", details: { providerCode: "dataforseo_40000" } },
    },
    {
      task: { status_code: 40210, status_message: "UPSTREAM_SENTINEL billing failure", path, cost: 0.05 },
      classify: true,
      verify: (error) => {
        assert.ok(error instanceof UnbilledCallError);
        assert.equal(error.message, "The DataForSEO account has a billing or balance issue.");
        assert.equal(error.status, 402);
        assert.equal(error.code, "dataforseo_balance");
      },
      response: { status: 402, code: "dataforseo_balance", details: { providerCode: "dataforseo_40210" } },
    },
  ];

  for (const row of rows) {
    const error = captureError(() => assertOk({
      status_code: 20000,
      tasks: [row.task],
    }, row.classify ? { classify, classifyPath: endpoint } : {}));
    row.verify(error);
    await assertErrorResponse(error, row.response);
    assert.equal((await toErrorResponse(error).text()).includes("UPSTREAM_SENTINEL"), false);
  }

  const noResults = { status_code: 40501, status_message: "No Search Results", path, cost: 0 };
  assert.equal(assertOk({ status_code: 20000, tasks: [noResults] }, { treatNoResultsAsEmpty: true }), noResults);
});
