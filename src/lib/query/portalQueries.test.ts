import test from "node:test";
import assert from "node:assert/strict";
import {
  featuresQueryOptions,
  overviewQueryOptions,
  gscQueryOptions,
  panelQueryOptions,
  scanReportQueryOptions,
} from "./portalQueries.ts";

test("portalQueries: builders set expected keys and enabled flags", () => {
  const builders = [
    { name: "features", fn: featuresQueryOptions, keyDomain: "features" },
    { name: "overview", fn: overviewQueryOptions, keyDomain: "overview" },
    { name: "gsc", fn: gscQueryOptions, keyDomain: "gsc" },
    { name: "panel", fn: panelQueryOptions, keyDomain: "panel" },
  ];

  for (const { name, fn, keyDomain } of builders) {
    const enabled = fn("acme");
    assert.deepEqual(enabled.queryKey.slice(0, 2), [keyDomain, "acme"]);
    assert.equal(enabled.enabled, true, `${name} should be enabled for non-empty brand`);
    assert.equal("placeholderData" in enabled, false, `${name} must not set placeholderData`);

    const disabled = fn("");
    assert.equal(disabled.enabled, false, `${name} should be disabled for empty brand`);
  }

  const reportEnabled = scanReportQueryOptions("scan-123");
  assert.deepEqual(reportEnabled.queryKey, ["scanReport", "scan-123"]);
  assert.equal(reportEnabled.enabled, true);
  assert.equal("placeholderData" in reportEnabled, false);

  const reportDisabled = scanReportQueryOptions("");
  assert.equal(reportDisabled.enabled, false);
});

test("portalQueries: panelQueryOptions sets staleTime: 0", () => {
  const panel = panelQueryOptions("acme");
  assert.equal(panel.staleTime, 0);
});

test("portalQueries: queryFn calls fetch with expected URL and passes signal", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      status: 200,
      ok: true,
      json: async () => ({ ok: true }),
    } as unknown as Response;
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const controller = new AbortController();

  await featuresQueryOptions("acme").queryFn({ signal: controller.signal });
  assert.equal(calls[0].url, "/api/customer/features?brand_key=acme");
  assert.equal(calls[0].init?.signal, controller.signal);

  await overviewQueryOptions("acme").queryFn({ signal: controller.signal });
  assert.equal(calls[1].url, "/api/customer/overview?brand_key=acme");

  await gscQueryOptions("acme").queryFn({ signal: controller.signal });
  assert.equal(calls[2].url, "/api/customer/gsc?brand_key=acme");

  await panelQueryOptions("acme").queryFn({ signal: controller.signal });
  assert.equal(calls[3].url, "/api/customer/repairs/panel?brand_key=acme");

  await scanReportQueryOptions("scan/1").queryFn({ signal: controller.signal });
  assert.equal(calls[4].url, "/api/customer/scan/report/scan%2F1");
});
