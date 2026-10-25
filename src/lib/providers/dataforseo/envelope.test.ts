// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/envelope.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDataforseoBillingClassifier } from "./billingClassification.ts";
import { z } from "zod";
import {
  assertOk,
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
    return new UnbilledCallError("Balance issue");
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
    (error: unknown) => error instanceof UnbilledCallError && error.message === "Balance issue",
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
      (error: unknown) => error instanceof UnbilledCallError && error.message === "DataForSEO balance issue",
    );
  }
  assert.throws(
    () => assertOk({ status_code: 40200, status_message: "Account balance too low" }, { classify, classifyPath: endpoint }),
    (error: unknown) => error instanceof UnbilledCallError && error.message === "DataForSEO balance issue",
  );
  assert.throws(
    () => assertOk({ status_code: 40000, status_message: "Payment required" }, { classify, classifyPath: endpoint }),
    (error: unknown) => error instanceof UnbilledCallError && error.message === "DataForSEO balance issue",
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

test("F01 call-outcome errors lack the ?6.2.2 status/code/details contract", () => {
  const errors = [
    new UnbilledCallError("unbilled"),
    new AmbiguousCallError("ambiguous"),
    new ChargedCallError("charged", { actualUsd: 0.05, provider: "dataforseo", endpoint: "/v3/example" }),
  ];
  for (const error of errors) {
    assert.equal("status" in error, false);
    assert.equal("code" in error, false);
    assert.equal("details" in error, false);
  }
});
