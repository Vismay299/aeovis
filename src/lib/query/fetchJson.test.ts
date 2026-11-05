/**
 * F05-AC-02 — `fetchJson` / `ApiError` / `withBrand`. `fetch` is injected, so
 * nothing touches the network; the fake response exposes only `status`, `ok`
 * and `json()` (the only members the helper may read).
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  fetchJson,
  isApiError,
  setUnauthorizedHandler,
  withBrand,
} from "./fetchJson.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(
  status: number,
  body: unknown,
  opts: { jsonThrows?: boolean } = {},
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (opts.jsonThrows) throw new SyntaxError("Unexpected end of JSON");
        return body;
      },
    };
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

function rejectingFetch(error: unknown): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

afterEach(() => setUnauthorizedHandler(null));

test("200 JSON resolves to the parsed value", async () => {
  const { fetch } = fakeFetch(200, { a: 1 });
  assert.deepEqual(await fetchJson("/x", {}, { fetch }), { a: 1 });
});

test("200 with an empty (unparseable) body resolves to null", async () => {
  const { fetch } = fakeFetch(200, undefined, { jsonThrows: true });
  assert.equal(await fetchJson("/x", {}, { fetch }), null);
});

test("sends no-store, same-origin and an Accept header; GET has no body or Content-Type", async () => {
  const { fetch, calls } = fakeFetch(200, {});
  await fetchJson("/x", undefined, { fetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/x");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json" });
  assert.equal(calls[0].init.body, undefined);
});

test("POST sets Content-Type and a JSON body", async () => {
  const { fetch, calls } = fakeFetch(200, {});
  await fetchJson("/x", { method: "POST", body: { q: "hi", n: 2 } }, { fetch });
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.equal(calls[0].init.body, JSON.stringify({ q: "hi", n: 2 }));
});

test("a falsy but defined body (null, 0) is still sent as JSON", async () => {
  const { fetch, calls } = fakeFetch(200, {});
  await fetchJson("/x", { method: "POST", body: null }, { fetch });
  assert.equal(calls[0].init.body, "null");
  assert.equal(
    (calls[0].init.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
});

test("the abort signal is passed through to fetch", async () => {
  const { fetch, calls } = fakeFetch(200, {});
  const controller = new AbortController();
  await fetchJson("/x", { signal: controller.signal }, { fetch });
  assert.equal(calls[0].init.signal, controller.signal);
});

test("schema is applied to the body on success", async () => {
  const { fetch } = fakeFetch(200, { n: "7" });
  const out = await fetchJson(
    "/x",
    { schema: { parse: (v) => Number((v as { n: string }).n) } },
    { fetch },
  );
  assert.equal(out, 7);
});

test("schema mismatch becomes invalid_response without leaking the body", async () => {
  const { fetch } = fakeFetch(200, { secret: "do-not-leak" });
  await assert.rejects(
    fetchJson(
      "/x",
      {
        schema: {
          parse: () => {
            throw new Error("bad shape do-not-leak");
          },
        },
      },
      { fetch },
    ),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 200);
      assert.equal(e.code, "invalid_response");
      assert.equal(e.message, "The server sent an unexpected response.");
      assert.ok(!JSON.stringify(e).includes("do-not-leak"));
      assert.equal(e.details, undefined);
      return true;
    },
  );
});

test("400 { error, code, recovery, details } maps onto ApiError fields", async () => {
  const { fetch } = fakeFetch(400, {
    error: "Bad input.",
    code: "validation_error",
    recovery: "Fix the field.",
    details: { field: "name" },
  });
  await assert.rejects(fetchJson("/x", {}, { fetch }), (e: unknown) => {
    assert.ok(isApiError(e));
    assert.equal(e.status, 400);
    assert.equal(e.code, "validation_error");
    assert.equal(e.message, "Bad input.");
    assert.equal(e.recovery, "Fix the field.");
    assert.deepEqual(e.details, { field: "name" });
    assert.equal(e.name, "ApiError");
    return true;
  });
});

test("legacy { detail } becomes the message, code falls back to http_<status>", async () => {
  const { fetch } = fakeFetch(500, { detail: "Legacy failure" });
  await assert.rejects(fetchJson("/x", {}, { fetch }), (e: unknown) => {
    assert.ok(isApiError(e));
    assert.equal(e.status, 500);
    assert.equal(e.code, "http_500");
    assert.equal(e.message, "Legacy failure");
    assert.equal(e.recovery, undefined);
    return true;
  });
});

test("error wins over detail; a non-JSON error body gives the status message", async () => {
  const a = fakeFetch(422, { error: "E", detail: "D" });
  await assert.rejects(fetchJson("/x", {}, { fetch: a.fetch }), {
    message: "E",
  });
  const b = fakeFetch(502, undefined, { jsonThrows: true });
  await assert.rejects(fetchJson("/x", {}, { fetch: b.fetch }), (e: unknown) => {
    assert.ok(isApiError(e));
    assert.equal(e.code, "http_502");
    assert.equal(e.message, "The request failed (502).");
    return true;
  });
});

test("401 calls the registered handler exactly once, then throws unauthenticated", async () => {
  let called = 0;
  setUnauthorizedHandler(() => {
    called += 1;
  });
  const { fetch } = fakeFetch(401, {});
  await assert.rejects(fetchJson("/x", {}, { fetch }), (e: unknown) => {
    assert.ok(isApiError(e));
    assert.equal(e.status, 401);
    assert.equal(e.code, "unauthenticated");
    assert.equal(called, 1);
    return true;
  });
  assert.equal(called, 1);
});

test("401 keeps the server's code when it sends one, and works with no handler", async () => {
  const { fetch } = fakeFetch(401, { error: "Session expired.", code: "session_expired" });
  await assert.rejects(fetchJson("/x", {}, { fetch }), {
    status: 401,
    code: "session_expired",
    message: "Session expired.",
  });
});

test("the handler is not called for non-401 failures or successes", async () => {
  let called = 0;
  setUnauthorizedHandler(() => {
    called += 1;
  });
  await assert.rejects(fetchJson("/x", {}, { fetch: fakeFetch(403, {}).fetch }));
  await assert.rejects(fetchJson("/x", {}, { fetch: fakeFetch(500, {}).fetch }));
  await fetchJson("/x", {}, { fetch: fakeFetch(200, {}).fetch });
  assert.equal(called, 0);
});

test("setUnauthorizedHandler(null) clears the handler", async () => {
  let called = 0;
  setUnauthorizedHandler(() => {
    called += 1;
  });
  setUnauthorizedHandler(null);
  await assert.rejects(fetchJson("/x", {}, { fetch: fakeFetch(401, {}).fetch }));
  assert.equal(called, 0);
});

test("a fetch TypeError becomes ApiError(0, network_error)", async () => {
  await assert.rejects(
    fetchJson("/x", {}, { fetch: rejectingFetch(new TypeError("fetch failed")) }),
    (e: unknown) => {
      assert.ok(isApiError(e));
      assert.equal(e.status, 0);
      assert.equal(e.code, "network_error");
      assert.equal(
        e.message,
        "Could not reach Perceev. Check your connection and try again.",
      );
      return true;
    },
  );
});

test("an AbortError is re-thrown unchanged", async () => {
  const abort = new DOMException("The operation was aborted.", "AbortError");
  await assert.rejects(
    fetchJson("/x", {}, { fetch: rejectingFetch(abort) }),
    (e: unknown) => {
      assert.equal(e, abort);
      assert.ok(!isApiError(e));
      return true;
    },
  );
});

test("an unknown fetch failure is not disguised as a network error", async () => {
  const odd = new RangeError("boom");
  await assert.rejects(
    fetchJson("/x", {}, { fetch: rejectingFetch(odd) }),
    (e: unknown) => e === odd,
  );
});

test("ApiError carries optional recovery/details and is detected by isApiError", () => {
  const bare = new ApiError(404, "http_404", "Nope");
  assert.equal(bare.recovery, undefined);
  assert.equal(bare.details, undefined);
  assert.ok(bare instanceof Error);
  assert.ok(isApiError(bare));
  assert.ok(!isApiError(new Error("x")));
  assert.ok(!isApiError({ status: 404, code: "x", message: "y" }));
  assert.ok(!isApiError(null));
});

test("withBrand appends brand_key and params, skipping undefined and null", () => {
  assert.equal(
    withBrand("/api/customer/overview", "acme", { range: "30d", x: undefined }),
    "/api/customer/overview?brand_key=acme&range=30d",
  );
  assert.equal(
    withBrand("/api/x", "acme", { a: null, b: 0, c: false }),
    "/api/x?brand_key=acme&b=0&c=false",
  );
  assert.equal(withBrand("/api/x", "acme"), "/api/x?brand_key=acme");
});

test("withBrand URL-encodes values and respects an existing query string", () => {
  assert.equal(
    withBrand("/api/x", "a b&c", { q: "x y/z" }),
    "/api/x?brand_key=a%20b%26c&q=x%20y%2Fz",
  );
  assert.equal(
    withBrand("/api/x?foo=1", "acme", { r: "7d" }),
    "/api/x?foo=1&brand_key=acme&r=7d",
  );
});
