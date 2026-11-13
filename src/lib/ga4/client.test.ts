import test from "node:test";
import assert from "node:assert/strict";

const { createGa4AdminClient, createGa4DataClient, Ga4AdminApiError, Ga4DataApiError, Ga4TokenError } =
  await import(new URL("./client.ts", import.meta.url).href);

function makeFetch(responses: any[]) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
}

test("admin client paginates accountSummaries", async () => {
  const fetchImpl = makeFetch([
    { body: { accountSummaries: [{ account: "accounts/1", displayName: "A", propertySummaries: [{ property: "properties/1", displayName: "P1" }] }], nextPageToken: "t2" } },
    { body: { accountSummaries: [{ account: "accounts/2", displayName: "B", propertySummaries: [{ property: "properties/2", displayName: "P2" }] }] } },
  ]);
  const client = createGa4AdminClient({ getToken: async () => "tok", fetchImpl });
  const props = await client.listProperties();
  assert.equal(props.length, 2);
  assert.equal(props[0].propertyId, "properties/1");
  assert.equal(props[1].propertyId, "properties/2");
});

test("admin client memoizes token across calls", async () => {
  let calls = 0;
  const fetchImpl = makeFetch([{ body: { email: "a@b.com" } }, { body: { email: "a@b.com" } }]);
  const client = createGa4AdminClient({ getToken: async () => { calls++; return "tok"; }, fetchImpl });
  await client.getUserInfoEmail();
  await client.getUserInfoEmail();
  assert.equal(calls, 1);
});

test("admin client throws Ga4AdminApiError on 403", async () => {
  const fetchImpl = async () => new Response("{}", { status: 403 });
  const client = createGa4AdminClient({ getToken: async () => "tok", fetchImpl });
  await assert.rejects(() => client.listProperties(), (err: any) => err instanceof Ga4AdminApiError && err.status === 403);
});

test("data client returns runReport response and exposes quota", async () => {
  const fetchImpl = makeFetch([{ body: { rowCount: 1, propertyQuota: { tokensPerHour: { consumed: 5, remaining: 100 } } } }]);
  const client = createGa4DataClient({ getToken: async () => "tok", propertyId: "properties/1", fetchImpl });
  const res = await client.runReport({ dateRanges: [{ startDate: "2026-01-01", endDate: "2026-01-02" }], dimensions: [], metrics: [], offset: "0", limit: "10", orderBys: [], keepEmptyRows: false, returnPropertyQuota: true } as any);
  assert.equal(res.rowCount, 1);
  assert.equal(res.propertyQuota?.tokensPerHour?.remaining, 100);
});

test("data client throws Ga4DataApiError on 429 with retryAfter", async () => {
  const fetchImpl = async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } });
  const client = createGa4DataClient({ getToken: async () => "tok", propertyId: "properties/1", fetchImpl });
  await assert.rejects(() => client.runReport({ dateRanges: [{ startDate: "2026-01-01", endDate: "2026-01-02" }], dimensions: [], metrics: [], offset: "0", limit: "10", orderBys: [], keepEmptyRows: false, returnPropertyQuota: true } as any), (err: any) => err instanceof Ga4DataApiError && err.status === 429 && err.retryAfterSeconds === 30);
});

test("data client rejects non-canonical property id", async () => {
  assert.throws(() => createGa4DataClient({ getToken: async () => "tok", propertyId: "bad", fetchImpl: async () => new Response("{}") }), /Invalid/);
});

test("token error when getToken throws", async () => {
  const fetchImpl = async () => new Response("{}");
  const client = createGa4AdminClient({ getToken: async () => { throw new Error("boom"); }, fetchImpl });
  await assert.rejects(() => client.getUserInfoEmail(), (err: any) => err instanceof Ga4TokenError);
});