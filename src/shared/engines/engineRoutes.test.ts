import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_ROUTE_ORDER,
  DATAFORSEO_APPROVED_ENGINES,
  parseAnswerEngineRoutes,
  routeOrder,
  isRouteConfigured,
  isRouteScanCapable,
  resolveFrozenRoutes,
  requestBudgetMs,
  leaseSecondsFor,
  laneConcurrency,
} from "./engineRoutes.ts";
import { configVersion, circuitIdentity } from "./providerReadiness.js";

const FIXTURE_PATH = path.resolve("tests/fixtures/f02/config-versions-today.json");

test("F02-AC-21: configVersion and circuitIdentity match today's fixture when ANSWER_ENGINE_ROUTES is unset", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const env = {
    LLM_API_KEY: "k1",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
    BRIGHTDATA_API_KEY: "k2",
    OPENROUTER_GEMINI_MODEL: "google/gemini-3.8-flash",
  };

  for (const [engine, expected] of Object.entries(fixture) as [string, any][]) {
    const cv = configVersion(engine, env);
    const ci = circuitIdentity(engine, env);
    assert.equal(cv, expected.configVersion, `configVersion mismatch for ${engine}`);
    assert.deepEqual(ci, expected.circuitIdentity, `circuitIdentity mismatch for ${engine}`);
  }
});

test("F02-AC-21: dataforseo route produces v1:dataforseo:direct:n/a:<model>:DATAFORSEO_API_KEY#<digest>", () => {
  const env = {
    DATAFORSEO_API_KEY: "dfs-key-123",
  };
  const cv = configVersion("chatgpt", env, { route: "dataforseo" });
  const ci = circuitIdentity("chatgpt", env, { route: "dataforseo" });

  assert.match(
    cv || "",
    /^v1:dataforseo:direct:n\/a:llm_scraper:chatgpt:DATAFORSEO_API_KEY#[0-9a-f]{16}$/,
  );
  assert.equal(ci.provider, "dataforseo");
  assert.match(ci.account || "", /^DATAFORSEO_API_KEY#[0-9a-f]{16}$/);

  // All dataforseo routes share the same account circuit
  const ciAio = circuitIdentity("aio", env, { route: "dataforseo" });
  assert.deepEqual(ci, ciAio);
});

test("parseAnswerEngineRoutes: parses valid route syntax and rejects invalid entries", () => {
  const parsed = parseAnswerEngineRoutes(
    "aio=dataforseo>brightdata;chatgpt=dataforseo>openrouter;gemini=dataforseo>openrouter;perplexity=dataforseo>vendor_api",
  );
  assert.deepEqual(parsed.aio, ["dataforseo", "brightdata"]);
  assert.deepEqual(parsed.chatgpt, ["dataforseo", "openrouter"]);
  assert.deepEqual(parsed.gemini, ["dataforseo", "openrouter"]);
  assert.deepEqual(parsed.perplexity, ["dataforseo", "vendor_api"]);

  assert.throws(
    () => parseAnswerEngineRoutes("unknown_engine=dataforseo"),
    (err: any) => err.code === "answer_engine_routes_invalid",
  );
  assert.throws(
    () => parseAnswerEngineRoutes("chatgpt=unknown_route"),
    (err: any) => err.code === "answer_engine_routes_invalid",
  );
});

test("routeOrder returns configured or default routes", () => {
  const env = {
    ANSWER_ENGINE_ROUTES: "chatgpt=openrouter>vendor_api",
  };
  assert.deepEqual(routeOrder("chatgpt", env), ["openrouter", "vendor_api"]);
  assert.deepEqual(routeOrder("gemini", env), DEFAULT_ROUTE_ORDER.gemini);
});

test("isRouteConfigured checks required environment credentials", () => {
  const env = {
    DATAFORSEO_API_KEY: "k_dfs",
    BRIGHTDATA_API_KEY: "k_bd",
    OPENAI_API_KEY: "k_oai",
    PERPLEXITY_API_KEY: "k_pplx",
    LLM_API_KEY: "k_or",
  };

  assert.equal(isRouteConfigured("chatgpt", "dataforseo", env), true);
  assert.equal(isRouteConfigured("aio", "brightdata", env), true);
  assert.equal(isRouteConfigured("chatgpt", "vendor_api", env), true);
  assert.equal(isRouteConfigured("perplexity", "vendor_api", env), true);
  assert.equal(isRouteConfigured("gemini", "vendor_api", env), false);

  assert.equal(isRouteConfigured("chatgpt", "dataforseo", {}), false);
  assert.equal(isRouteConfigured("aio", "brightdata", {}), false);
});

test("isRouteScanCapable enables queued routes only after queue collection is ready", () => {
  assert.equal(isRouteScanCapable("perplexity", "dataforseo"), true);
  assert.equal(isRouteScanCapable("chatgpt", "dataforseo"), true);
  assert.equal(isRouteScanCapable("gemini", "dataforseo"), true);
  assert.equal(isRouteScanCapable("aio", "dataforseo"), true);
  assert.equal(isRouteScanCapable("chatgpt", "openrouter"), true);
});

test("F02-AC-22: resolveFrozenRoutes selects first valid route, handles fallback and open circuits", async () => {
  const env = {
    ANSWER_ENGINE_ROUTES: "perplexity=dataforseo>openrouter;chatgpt=dataforseo>openrouter",
    DATAFORSEO_API_KEY: "dfs_k",
    LLM_API_KEY: "or_k",
  };

  // 1. With dataforseo_engines OFF: perplexity falls back to openrouter
  const r1 = await resolveFrozenRoutes(["perplexity", "chatgpt"], {
    env,
    isFeatureEnabled: async () => false,
    openCircuitKeys: new Set(),
  });
  assert.equal(r1.perplexity.route, "openrouter");
  assert.equal(r1.perplexity.fallbackFrom, "dataforseo");
  assert.equal(r1.chatgpt.route, "openrouter");

  // 2. With dataforseo_engines ON, approved queued engines select DataForSEO now that phase 4 is ready.
  const r2 = await resolveFrozenRoutes(["perplexity", "chatgpt"], {
    env,
    isFeatureEnabled: async () => true,
    openCircuitKeys: new Set(),
    resolveModel: async () => "sonar",
  });
  assert.equal(
    r2.chatgpt.route,
    DATAFORSEO_APPROVED_ENGINES.includes("chatgpt") ? "dataforseo" : "openrouter",
  );
  if (!DATAFORSEO_APPROVED_ENGINES.includes("perplexity")) {
    assert.equal(r2.perplexity.route, "openrouter");
    assert.equal(r2.perplexity.fallbackFrom, "dataforseo");
  }

  // 3. Open circuit on openrouter falls back or defaults
  const openrouterCircuit = circuitIdentity("chatgpt", env, { route: "openrouter" });
  const openKey = (await import("../../server/db/probeDispatch.js")).hashIdentity(openrouterCircuit);
  const r3 = await resolveFrozenRoutes(["chatgpt"], {
    env,
    isFeatureEnabled: async () => false,
    openCircuitKeys: new Set([openKey]),
  });
  // If openrouter circuit is open and no other route qualifies, resolves to first configured route (openrouter)
  assert.equal(r3.chatgpt.route, "openrouter");
});

test("budget, lease, and concurrency helpers", () => {
  assert.equal(requestBudgetMs("chatgpt", "dataforseo"), 140_000);
  assert.equal(requestBudgetMs("aio", "dataforseo"), 140_000);
  assert.equal(requestBudgetMs("perplexity", "dataforseo"), 100_000);
  assert.equal(requestBudgetMs("chatgpt", "openrouter"), 70_000);

  assert.equal(leaseSecondsFor("chatgpt", "dataforseo"), 180);
  assert.equal(leaseSecondsFor("chatgpt", "openrouter"), 120);

  assert.equal(laneConcurrency("perplexity", "dataforseo"), 3);
  assert.equal(laneConcurrency("perplexity", "dataforseo", { DATAFORSEO_SCAN_MODEL_CONCURRENCY: "5" }), 5);
  assert.equal(laneConcurrency("chatgpt", "dataforseo"), 1);
  assert.equal(laneConcurrency("chatgpt", "openrouter"), 1);
});
