import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../shared/http/appError.ts";
import {
  SpendRefused,
  ChargedCallError,
  UnbilledCallError,
  AmbiguousCallError,
} from "../../shared/spend/errors.ts";
import { CacheOnlyMiss } from "./cache.ts";
import { toResearchError } from "./providerErrors.ts";

const opts = {
  unavailableCode: "research_unavailable",
  unavailableMessage: "Keyword research is unavailable right now. Try again shortly.",
};

test("toResearchError leaves SpendRefused unchanged", () => {
  const err = new SpendRefused("daily_cap");
  const res = toResearchError(err, opts);
  assert.equal(res, err);
});

test("toResearchError leaves CacheOnlyMiss unchanged", () => {
  const err = new CacheOnlyMiss();
  const res = toResearchError(err, opts);
  assert.equal(res, err);
});

test("toResearchError leaves non-dataforseo AppErrors unchanged", () => {
  const err = new AppError(404, "workspace_not_found", "Workspace not found");
  const res = toResearchError(err, opts);
  assert.equal(res, err);
});

test("toResearchError maps dataforseo_invalid_field to 422 research_invalid", () => {
  const err = new AppError(422, "dataforseo_invalid_field", "Invalid field: target");
  const res = toResearchError(err, opts) as AppError;
  assert.ok(res instanceof AppError);
  assert.equal(res.status, 422);
  assert.equal(res.code, "research_invalid");
  assert.equal(res.message, "DataForSEO could not use this input. Try a different keyword or market.");
});

test("toResearchError maps dataforseo_not_configured to 503 research_not_configured", () => {
  const err = new AppError(503, "dataforseo_not_configured", "Not configured");
  const res = toResearchError(err, opts) as AppError;
  assert.ok(res instanceof AppError);
  assert.equal(res.status, 503);
  assert.equal(res.code, "research_not_configured");
  assert.equal(res.message, "Research data is not configured yet. Contact Perceev support.");
});

test("toResearchError maps generic dataforseo_* AppError to 502 with providerCode", () => {
  const err = new AppError(502, "dataforseo_timeout", "Gateway timeout");
  const res = toResearchError(err, opts) as AppError;
  assert.ok(res instanceof AppError);
  assert.equal(res.status, 502);
  assert.equal(res.code, opts.unavailableCode);
  assert.equal(res.message, opts.unavailableMessage);
  assert.deepEqual(res.details, { providerCode: "dataforseo_timeout" });
});

test("toResearchError maps UnbilledCallError to 502 with providerCode", () => {
  const err = new UnbilledCallError("Account balance issue", {
    status: 402,
    code: "dataforseo_balance",
    details: { providerCode: "dataforseo_40200" },
  });
  const res = toResearchError(err, opts) as AppError;
  assert.ok(res instanceof AppError);
  assert.equal(res.status, 502);
  assert.equal(res.code, opts.unavailableCode);
  assert.deepEqual(res.details, { providerCode: "dataforseo_balance" });
});

test("toResearchError maps ChargedCallError to 502 with fallback providerCode", () => {
  const err = new ChargedCallError("Server error after charge", {
    actualUsd: 0.012,
    provider: "dataforseo",
    endpoint: "/v3/dataforseo_labs/google/related_keywords/live",
  });
  const res = toResearchError(err, opts) as AppError;
  assert.ok(res instanceof AppError);
  assert.equal(res.status, 502);
  assert.equal(res.code, opts.unavailableCode);
  assert.deepEqual(res.details, { providerCode: "dataforseo_call_failed" });
});

test("toResearchError maps AmbiguousCallError to 502 with providerCode", () => {
  const err = new AmbiguousCallError("Timeout waiting for response", {
    code: "dataforseo_ambiguous_timeout",
  });
  const res = toResearchError(err, opts) as AppError;
  assert.ok(res instanceof AppError);
  assert.equal(res.status, 502);
  assert.equal(res.code, opts.unavailableCode);
  assert.deepEqual(res.details, { providerCode: "dataforseo_ambiguous_timeout" });
});
