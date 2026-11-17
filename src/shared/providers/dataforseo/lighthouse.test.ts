// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/lighthouse.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchLighthouseResult, LIGHTHOUSE_PATH } from "./lighthouse.ts";
import { AmbiguousCallError, ChargedCallError } from "../../spend/errors.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../../../tests/fixtures/site-audit/dataforseo");
const dummyEnv = { DATAFORSEO_API_KEY: "dummy-key" };

function fixture(name: string) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

test("success returns parsed payload and settles provider cost", async () => {
  let calls = 0;
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls += 1;
    capturedBody = init?.body as string;
    return jsonResponse(fixture("lighthouse-mobile.json"));
  };
  const { data, billing } = await fetchLighthouseResult(
    { url: "https://example.com/", strategy: "mobile" },
    { fetchImpl, env: dummyEnv },
  );
  assert.equal(calls, 1);
  assert.deepEqual(billing, { path: ["v3", "on_page", "lighthouse", "live", "json"], costUsd: 0.00425 });
  assert.equal(data.metadata.finalUrl, "https://example.com/");
  assert.equal(data.metadata.strategy, "mobile");
  assert.equal(data.scores.performance, 54);
  assert.ok(data.issues.length >= 1);
  const parsed = JSON.parse(capturedBody ?? "[]");
  assert.equal(parsed[0].url, "https://example.com/");
  assert.equal(parsed[0].for_mobile, true);
  assert.deepEqual(parsed[0].categories, ["performance", "accessibility", "best_practices", "seo"]);
});

test("carries billing metadata when parsing fails after a billed success", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [
        {
          id: "task-1",
          status_code: 20000,
          status_message: "Ok.",
          path: ["v3", "on_page", "lighthouse", "live", "json"],
          cost: 0.00425,
          result: [{ requestedUrl: "https://example.com/", finalUrl: "https://example.com/", categories: {}, audits: {} }],
        },
      ],
    });
  await assert.rejects(
    fetchLighthouseResult({ url: "https://example.com/", strategy: "mobile" }, { fetchImpl, env: dummyEnv }),
    (err: unknown) => {
      assert.ok(err instanceof ChargedCallError);
      assert.equal((err as ChargedCallError).actualUsd, 0.00425);
      assert.equal((err as ChargedCallError).provider, "dataforseo");
      assert.equal((err as ChargedCallError).endpoint, LIGHTHOUSE_PATH);
      return true;
    },
  );
});

test("task error with cost throws ChargedCallError carrying the billed cost", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse(fixture("lighthouse-task-error.json"));
  await assert.rejects(
    fetchLighthouseResult({ url: "https://example.com/", strategy: "mobile" }, { fetchImpl, env: dummyEnv }),
    (err: unknown) => {
      assert.ok(err instanceof ChargedCallError);
      assert.equal((err as ChargedCallError).actualUsd, 0.00425);
      return true;
    },
  );
});

test("5xx throws AmbiguousCallError and is not retried", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("upstream failure", { status: 503 });
  };
  await assert.rejects(
    fetchLighthouseResult({ url: "https://example.com/", strategy: "mobile" }, { fetchImpl, env: dummyEnv }),
    (err: unknown) => {
      assert.ok(err instanceof AmbiguousCallError);
      return true;
    },
  );
  assert.equal(calls, 1);
});
