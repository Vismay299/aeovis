import test from "node:test";
import assert from "node:assert/strict";
import {
  groupUrlsByHost,
  describeResponse,
  postToEngine,
  submitHost,
  submitUrls,
  INDEXNOW_ENDPOINTS,
} from "./submit.ts";
import { AppError } from "../http/errors.ts";

const KEY = "0123456789abcdef0123456789abcdef";

test("groupUrlsByHost groups by host, strips hash, de-duplicates and skips invalid/off-site", () => {
  const domain = "example.com";
  const urls = [
    "https://example.com/a#section",
    "https://www.example.com/b",
    "https://example.com/a",
    "https://notexample.com/c",
    "not a url",
    "ftp://example.com/file",
    "https://sub.example.com/page",
  ];

  const { byHost, skipped } = groupUrlsByHost(domain, urls);

  assert.deepEqual(byHost.get("example.com"), ["https://example.com/a"]);
  assert.deepEqual(byHost.get("www.example.com"), ["https://www.example.com/b"]);
  assert.deepEqual(byHost.get("sub.example.com"), ["https://sub.example.com/page"]);

  assert.equal(skipped.length, 3);
  assert.deepEqual(skipped, [
    { url: "https://notexample.com/c", reason: "off_site" },
    { url: "not a url", reason: "invalid" },
    { url: "ftp://example.com/file", reason: "invalid" },
  ]);
});

test("describeResponse returns exact copy and status per spec §6.2.3", () => {
  assert.deepEqual(describeResponse(200, 1, "example.com"), {
    status: "submitted",
    reason: null,
    message: "Submitted 1 URL.",
  });
  assert.deepEqual(describeResponse(200, 3, "example.com"), {
    status: "submitted",
    reason: null,
    message: "Submitted 3 URLs.",
  });
  assert.deepEqual(describeResponse(202, 1, "example.com"), {
    status: "submitted",
    reason: null,
    message: "Submitted 1 URL. Search engines will verify the key file on https://example.com first.",
  });
  assert.deepEqual(describeResponse(400, 1, "example.com"), {
    status: "failed",
    reason: "bad_request",
    message: "IndexNow rejected the request. Check that the URLs are complete addresses.",
  });
  assert.deepEqual(describeResponse(403, 1, "example.com"), {
    status: "failed",
    reason: "key_rejected",
    message: "The key wasn't accepted. Check that the key file on https://example.com contains only the key.",
  });
  assert.deepEqual(describeResponse(422, 1, "example.com"), {
    status: "failed",
    reason: "urls_rejected",
    message: "IndexNow rejected these URLs. Check that they belong to https://example.com.",
  });
  assert.deepEqual(describeResponse(429, 1, "example.com"), {
    status: "failed",
    reason: "rate_limited",
    message: "Search engines are refusing submissions right now. Try again later, and only submit pages that changed.",
  });
  assert.deepEqual(describeResponse(500, 1, "example.com"), {
    status: "failed",
    reason: "http_error",
    message: "IndexNow returned HTTP 500.",
  });
});

test("postToEngine sends POST and handles status codes and errors", async () => {
  const fetchMockSuccess: any = async () => new Response(null, { status: 200 });
  const status200 = await postToEngine(INDEXNOW_ENDPOINTS[0], "{}", { fetchImpl: fetchMockSuccess });
  assert.equal(status200, 200);

  const fetchMockError: any = async () => {
    throw new Error("network timeout");
  };
  const statusErr = await postToEngine(INDEXNOW_ENDPOINTS[0], "{}", { fetchImpl: fetchMockError });
  assert.equal(statusErr, undefined);
});

test("submitHost gates submission when key file problem exists (F19-AC-06)", async () => {
  let engineCalled = false;
  const safeFetchMock: any = async () => ({
    url: "https://example.com/" + KEY + ".txt",
    status: 404,
    headers: new Headers(),
    text: () => "Not Found",
  });
  const fetchImplMock: any = async () => {
    engineCalled = true;
    return new Response(null, { status: 200 });
  };

  const res = await submitHost("example.com", KEY, ["https://example.com/p1"], {
    safeFetch: safeFetchMock,
    fetchImpl: fetchImplMock,
  });

  assert.equal(res.status, "failed");
  assert.equal(res.reason, "missing");
  assert.equal(res.message, "No key file at the root of https://example.com. Upload it there, then try again.");
  assert.equal(engineCalled, false);
});

test("submitHost proceeds when key file check is bot wall (unknown) (F19-AC-06 / port :137)", async () => {
  const safeFetchMock: any = async () => ({
    url: "https://example.com/" + KEY + ".txt",
    status: 403,
    headers: new Headers(),
    text: () => "Forbidden",
  });

  const calledEngines: string[] = [];
  const fetchImplMock: any = async (url: string) => {
    calledEngines.push(url);
    return new Response(null, { status: 202 });
  };

  const res = await submitHost("example.com", KEY, ["https://example.com/p1"], {
    safeFetch: safeFetchMock,
    fetchImpl: fetchImplMock,
  });

  assert.equal(res.status, "submitted");
  assert.equal(res.engine, "bing");
  assert.equal(res.httpStatus, 202);
  assert.equal(calledEngines.length, 1);
});

test("submitHost falls back Bing -> Yandex -> Yep on 429/5xx (F19-AC-07 / port :151)", async () => {
  const safeFetchMock: any = async () => ({
    url: "https://example.com/" + KEY + ".txt",
    status: 200,
    headers: new Headers(),
    text: () => KEY,
  });

  const calledEngines: string[] = [];
  const fetchImplMock: any = async (url: string) => {
    calledEngines.push(url);
    if (url.includes("bing")) {
      return new Response(null, { status: 429 });
    }
    if (url.includes("yandex")) {
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 200 });
  };

  const res = await submitHost("example.com", KEY, ["https://example.com/p1"], {
    safeFetch: safeFetchMock,
    fetchImpl: fetchImplMock,
  });

  assert.equal(res.status, "submitted");
  assert.equal(res.engine, "yep");
  assert.equal(res.httpStatus, 200);
  assert.equal(calledEngines.length, 3);
});

test("submitHost stops on key rejection 403 without trying next engine (F19-AC-07 / port :169)", async () => {
  const safeFetchMock: any = async () => ({
    url: "https://example.com/" + KEY + ".txt",
    status: 200,
    headers: new Headers(),
    text: () => KEY,
  });

  const calledEngines: string[] = [];
  const fetchImplMock: any = async (url: string) => {
    calledEngines.push(url);
    return new Response(null, { status: 403 });
  };

  const res = await submitHost("example.com", KEY, ["https://example.com/p1"], {
    safeFetch: safeFetchMock,
    fetchImpl: fetchImplMock,
  });

  assert.equal(res.status, "failed");
  assert.equal(res.reason, "key_rejected");
  assert.equal(res.engine, "bing");
  assert.equal(res.httpStatus, 403);
  assert.equal(calledEngines.length, 1);
});

test("submitUrls validates input, creates key on first use, skips recently submitted, records rows", async () => {
  const insertedSubmissions: any[] = [];
  const admin: any = {
    from: (table: string) => {
      if (table === "indexnow_submissions") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({ data: [], error: null }),
            }),
          }),
          insert: async (rows: any[]) => {
            insertedSubmissions.push(...rows);
            return { error: null };
          },
        };
      }
      if (table === "indexnow_keys") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { key: KEY }, error: null }),
            }),
          }),
        };
      }
      return {};
    },
    rpc: async (fn: string, params: any) => {
      if (fn === "indexnow_ensure_key") {
        return { data: [{ key: KEY, created: true }], error: null };
      }
      if (fn === "indexnow_usage") {
        return {
          data: {
            requestsLastHour: 0,
            urlsToday: 0,
            checksLastHour: 0,
          },
          error: null,
        };
      }
      if (fn === "indexnow_recently_submitted") {
        // Mock p1 already recently submitted
        return { data: ["https://example.com/p1"], error: null };
      }
      return { data: null, error: null };
    },
  };

  const safeFetchMock: any = async () => ({
    url: "https://example.com/" + KEY + ".txt",
    status: 200,
    headers: new Headers(),
    text: () => KEY,
  });

  const fetchImplMock: any = async () => new Response(null, { status: 200 });

  const ws = {
    brandKey: "b1",
    brand: { website_host: "example.com" },
    user: { id: "u1" },
  };

  const res = await submitUrls(
    admin,
    ws,
    {
      urls: [
        "https://example.com/p1", // recently submitted
        "https://example.com/p2", // valid
        "https://notexample.com/p3", // off site
      ],
      source: "settings",
      requestId: "11111111-1111-1111-1111-111111111111",
    },
    {
      safeFetch: safeFetchMock,
      fetchImpl: fetchImplMock,
    }
  );

  assert.equal(res.key, KEY);
  assert.equal(res.keyCreated, true);
  assert.equal(res.hosts.length, 1);
  assert.equal(res.hosts[0].host, "example.com");
  assert.equal(res.hosts[0].status, "submitted");
  assert.equal(res.hosts[0].urlCount, 1); // p2 only

  assert.equal(res.skipped.length, 2);
  assert.ok(res.skipped.some((s) => s.url === "https://notexample.com/p3" && s.reason === "off_site"));
  assert.ok(res.skipped.some((s) => s.url === "https://example.com/p1" && s.reason === "recently_submitted"));

  assert.equal(insertedSubmissions.length, 1);
  assert.equal(insertedSubmissions[0].host, "example.com");
  assert.equal(insertedSubmissions[0].source, "settings");
});

test("submitUrls idempotency: returns existing recorded rows without calling engine", async () => {
  let engineCalled = false;
  const existingRecordedRow = {
    host: "example.com",
    url_count: 1,
    status: "submitted",
    engine: "bing",
    http_status: 200,
    reason: null,
    message: "Submitted 1 URL.",
  };

  const admin: any = {
    from: (table: string) => {
      if (table === "indexnow_submissions") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({ data: [existingRecordedRow], error: null }),
            }),
          }),
        };
      }
      if (table === "indexnow_keys") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { key: KEY }, error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };

  const fetchImplMock: any = async () => {
    engineCalled = true;
    return new Response(null, { status: 200 });
  };

  const ws = {
    brandKey: "b1",
    brand: { website_host: "example.com" },
  };

  const res = await submitUrls(
    admin,
    ws,
    {
      urls: ["https://example.com/p1"],
      source: "settings",
      requestId: "22222222-2222-2222-2222-222222222222",
    },
    { fetchImpl: fetchImplMock }
  );

  assert.equal(res.keyCreated, false);
  assert.equal(res.hosts.length, 1);
  assert.equal(res.hosts[0].message, "Submitted 1 URL.");
  assert.equal(engineCalled, false);
});

test("submitUrls refuses brand without website with 400 invalid_request (port :100)", async () => {
  const admin: any = {};
  const ws = { brandKey: "b1", brand: { website_host: "" } };

  await assert.rejects(
    () =>
      submitUrls(admin, ws, {
        urls: ["https://example.com/p1"],
        source: "settings",
        requestId: "33333333-3333-3333-3333-333333333333",
      }),
    (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "invalid_request"
  );
});
