// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/ga4Client.test.ts:36-292
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createGa4AdminClient,
  createGa4DataClient,
  Ga4AdminApiError,
  Ga4DataApiError,
  Ga4MalformedResponseError,
  Ga4TokenError,
} from "./client.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/f20/${name}`, import.meta.url), "utf8"));

type Call = { url: string; init?: RequestInit };

function scripted(responses: Array<Response | Error | (() => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function countingToken(value = "ga4_tok") {
  const state = { calls: 0 };
  return { state, getToken: async () => { state.calls += 1; return value; } };
}

const reportRequest = {
  dateRanges: [{ startDate: "2026-07-01", endDate: "2026-07-28" }],
  dimensions: [{ name: "hostName" }],
  metrics: [{ name: "sessions" }],
  offset: "0",
  limit: "100",
  orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
  keepEmptyRows: false as const,
  returnPropertyQuota: true as const,
};
const emptyReport = () => Response.json({ dimensionHeaders: [{ name: "hostName" }], metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }], rowCount: 0 });

describe("GA4 admin client", () => {
  it("uses the dedicated grant's token once and paginates property discovery", async () => {
    const { fetchImpl, calls } = scripted([Response.json(fixture("account-summaries-page1.json")), Response.json(fixture("account-summaries-page2.json"))]);
    const token = countingToken();
    const properties = await createGa4AdminClient({ getToken: token.getToken, fetchImpl }).listProperties();
    assert.deepEqual(properties, [
      { propertyId: "properties/11", displayName: "Site A", accountDisplayName: "Agency" },
      { propertyId: "properties/22", displayName: "Site B", accountDisplayName: "Client" },
    ]);
    assert.match(calls[1].url, /pageToken=page-2/);
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer ga4_tok");
    assert.equal(token.state.calls, 1);
  });

  it("reads one property", async () => {
    const { fetchImpl, calls } = scripted([Response.json(fixture("property.json"))]);
    const property = await createGa4AdminClient({ getToken: async () => "t", fetchImpl }).getProperty("properties/22");
    assert.equal(calls[0].url, "https://analyticsadmin.googleapis.com/v1beta/properties/22");
    assert.equal(property.timeZone, "Asia/Kolkata");
  });

  it("classifies a rejected grant as a typed 401 admin error", async () => {
    const { fetchImpl } = scripted([Response.json({ error: "expired" }, { status: 401 })]);
    await assert.rejects(
      createGa4AdminClient({ getToken: async () => "t", fetchImpl }).listProperties(),
      (err: any) => err instanceof Ga4AdminApiError && err.status === 401,
    );
  });

  it("classifies a repeated transport failure as a typed status-0 admin error", async () => {
    const { fetchImpl } = scripted([new TypeError("connection reset"), new TypeError("connection reset")]);
    await assert.rejects(
      createGa4AdminClient({ getToken: async () => "t", fetchImpl }).listProperties(),
      (err: any) => err instanceof Ga4AdminApiError && err.status === 0,
    );
  });

  it("throws a token error when no access token can be minted", async () => {
    const { fetchImpl, calls } = scripted([]);
    await assert.rejects(
      createGa4AdminClient({ getToken: async () => { throw new Error("revoked"); }, fetchImpl }).listProperties(),
      (err: any) => err instanceof Ga4TokenError,
    );
    assert.equal(calls.length, 0);
  });

  it("rejects a malformed successful response as a typed error", async () => {
    const { fetchImpl } = scripted([Response.json({ accountSummaries: "nope" })]);
    await assert.rejects(
      createGa4AdminClient({ getToken: async () => "t", fetchImpl }).listProperties(),
      (err: any) => err instanceof Ga4MalformedResponseError,
    );
  });
});

describe("GA4 data client", () => {
  it("posts a fixed report to the selected property", async () => {
    const { fetchImpl, calls } = scripted([emptyReport()]);
    const result = await createGa4DataClient({ getToken: async () => "token", propertyId: "properties/123", fetchImpl }).runReport(reportRequest);
    assert.equal(result.rowCount, 0);
    assert.equal(calls[0].url, "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, JSON.stringify(reportRequest));
  });

  it("reuses one token promise for concurrent reports on the same client", async () => {
    const { fetchImpl, calls } = scripted([emptyReport(), emptyReport()]);
    const token = countingToken();
    const client = createGa4DataClient({ getToken: token.getToken, propertyId: "properties/123", fetchImpl });
    await Promise.all([client.runReport(reportRequest), client.runReport(reportRequest)]);
    assert.equal(calls.length, 2);
    assert.equal(token.state.calls, 1);
  });

  it("classifies quota failures, keeps a safe retry delay and never retries a 429", async () => {
    const { fetchImpl, calls } = scripted([
      new Response('{"error":{"message":"private upstream detail"}}', { status: 429, headers: { "retry-after": "120" } }),
    ]);
    await assert.rejects(
      createGa4DataClient({ getToken: async () => "t", propertyId: "properties/123", fetchImpl }).runReport(reportRequest),
      (err: any) => {
        assert.ok(err instanceof Ga4DataApiError);
        assert.equal(err.status, 429);
        assert.equal(err.retryAfterSeconds, 120);
        assert.doesNotMatch(String(err.message), /private upstream detail/);
        return true;
      },
    );
    assert.equal(calls.length, 1, "a 429 is not retried");
  });

  it("retries a 5xx exactly once", async () => {
    const { fetchImpl, calls } = scripted([new Response("{}", { status: 503 }), emptyReport()]);
    const result = await createGa4DataClient({ getToken: async () => "t", propertyId: "properties/123", fetchImpl }).runReport(reportRequest);
    assert.equal(result.rowCount, 0);
    assert.equal(calls.length, 2);

    const failing = scripted([new Response("{}", { status: 500 }), new Response("{}", { status: 502 })]);
    await assert.rejects(
      createGa4DataClient({ getToken: async () => "t", propertyId: "properties/123", fetchImpl: failing.fetchImpl }).runReport(reportRequest),
      (err: any) => err instanceof Ga4DataApiError && err.status === 502,
    );
    assert.equal(failing.calls.length, 2);
  });

  it("retains only safe Google error categories from a rejected request", async () => {
    const { fetchImpl } = scripted([
      Response.json({ error: { message: "contains project-specific private detail", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED", metadata: { service: "analyticsdata.googleapis.com" } }] } }, { status: 403 }),
    ]);
    await assert.rejects(
      createGa4DataClient({ getToken: async () => "t", propertyId: "properties/123", fetchImpl }).runReport(reportRequest),
      (err: any) => err.status === 403 && err.upstreamReason === "SERVICE_DISABLED" && !String(err.message).includes("private detail"),
    );
  });

  it("rejects malformed successful responses", async () => {
    const { fetchImpl } = scripted([Response.json({ rows: "not-an-array" })]);
    await assert.rejects(
      createGa4DataClient({ getToken: async () => "t", propertyId: "properties/123", fetchImpl }).runReport(reportRequest),
      (err: any) => err instanceof Ga4MalformedResponseError,
    );
  });

  it("rejects a non-canonical property identifier before fetching", () => {
    const { fetchImpl, calls } = scripted([]);
    assert.throws(() => createGa4DataClient({ getToken: async () => "t", propertyId: "123", fetchImpl }));
    assert.equal(calls.length, 0);
  });

  it("converts repeated transport failures to a typed status-0 error", async () => {
    const { fetchImpl } = scripted([new TypeError("DNS failure"), new TypeError("DNS failure")]);
    await assert.rejects(
      createGa4DataClient({ getToken: async () => "t", propertyId: "properties/123", fetchImpl }).runReport(reportRequest),
      (err: any) => err instanceof Ga4DataApiError && err.status === 0,
    );
  });

  it("runs at most 4 reports per property at once: the 5th waits for a slot", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const fetchImpl = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return emptyReport();
    }) as typeof fetch;
    const client = createGa4DataClient({ getToken: async () => "t", propertyId: "properties/777", fetchImpl });
    const runs = Array.from({ length: 6 }, () => client.runReport(reportRequest));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(inFlight, 4, "the 5th and 6th requests wait");
    // Release one; exactly one waiter may take its slot.
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(inFlight, 4);
    while (releases.length || inFlight) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(runs);
    assert.equal(peak, 4);
  });
});
