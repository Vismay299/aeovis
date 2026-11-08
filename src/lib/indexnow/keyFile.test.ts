import test from "node:test";
import assert from "node:assert/strict";
import {
  checkKeyFile,
  keyFileProblem,
  checkKeyFiles,
  KEY_FILE_MAX_BYTES,
  KEY_CHECK_TIMEOUT_MS,
  INDEXNOW_USER_AGENT,
} from "./keyFile.ts";
import { AppError } from "../http/errors.ts";
import { SsrfBlockedError } from "../ssrfGuard.js";

const KEY = "0123456789abcdef0123456789abcdef";

function mockSafeFetchResult(status: number, textBody: string, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  const bytes = new TextEncoder().encode(textBody);
  return {
    url: "https://example.com/" + KEY + ".txt",
    status,
    headers: h,
    body: bytes,
    truncated: false,
    text: () => textBody,
    json: () => JSON.parse(textBody),
  };
}

test("F19-AC-04: status 2xx body equal to the key -> found", async () => {
  const safeFetchMock: any = async (url: string, init: any) => {
    assert.equal(init.method, "GET");
    assert.equal(init.headers["user-agent"], INDEXNOW_USER_AGENT);
    assert.equal(init.maxRedirects, 0);
    assert.equal(init.maxBytes, KEY_FILE_MAX_BYTES);
    assert.equal(init.timeoutMs, KEY_CHECK_TIMEOUT_MS);
    return mockSafeFetchResult(200, `  ${KEY}  \n`);
  };

  const status = await checkKeyFile("example.com", KEY, { safeFetch: safeFetchMock });
  assert.equal(status, "found");
});

test("F19-AC-04: status 2xx with different body -> wrong_content", async () => {
  const safeFetchMock: any = async () => mockSafeFetchResult(200, "something else");
  const status = await checkKeyFile("example.com", KEY, { safeFetch: safeFetchMock });
  assert.equal(status, "wrong_content");
});

test("F19-AC-04: body over 4096 bytes (response_too_large) -> wrong_content", async () => {
  const safeFetchMock: any = async () => {
    throw new AppError(422, "response_too_large", "The response was larger than the limit.");
  };
  const status = await checkKeyFile("example.com", KEY, { safeFetch: safeFetchMock });
  assert.equal(status, "wrong_content");
});

test("F19-AC-04: status 404 and 410 -> missing", async () => {
  let status = await checkKeyFile("example.com", KEY, {
    safeFetch: (async () => mockSafeFetchResult(404, "Not Found")) as any,
  });
  assert.equal(status, "missing");

  status = await checkKeyFile("example.com", KEY, {
    safeFetch: (async () => mockSafeFetchResult(410, "Gone")) as any,
  });
  assert.equal(status, "missing");
});

test("F19-AC-04: status 3xx with Location to same file on another host -> moved", async () => {
  const safeFetchMock: any = async () =>
    mockSafeFetchResult(301, "", {
      location: `https://www.example.com/${KEY}.txt`,
    });
  const status = await checkKeyFile("example.com", KEY, { safeFetch: safeFetchMock });
  assert.equal(status, "moved");
});

test("F19-AC-04: status 3xx otherwise (e.g. login or home) -> redirects", async () => {
  let status = await checkKeyFile("example.com", KEY, {
    safeFetch: (async () => mockSafeFetchResult(301, "", { location: "https://example.com/" })) as any,
  });
  assert.equal(status, "redirects");

  status = await checkKeyFile("example.com", KEY, {
    safeFetch: (async () => mockSafeFetchResult(302, "")) as any,
  });
  assert.equal(status, "redirects");
});

test("F19-AC-04: status 401, 403, 429, 500 -> unknown", async () => {
  for (const code of [401, 403, 429, 500, 503]) {
    const status = await checkKeyFile("example.com", KEY, {
      safeFetch: (async () => mockSafeFetchResult(code, "Error")) as any,
    });
    assert.equal(status, "unknown", `status ${code} should map to unknown`);
  }
});

test("F19-AC-04: timeout/abort -> unknown", async () => {
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  const status = await checkKeyFile("example.com", KEY, {
    safeFetch: (async () => {
      throw abortError;
    }) as any,
  });
  assert.equal(status, "unknown");
});

test("F19-AC-04: connection refused, DNS error, SSRF refusal -> unreachable", async () => {
  let status = await checkKeyFile("example.com", KEY, {
    safeFetch: (async () => {
      throw new AppError(422, "url_unreachable", "Connection refused.");
    }) as any,
  });
  assert.equal(status, "unreachable");

  status = await checkKeyFile("example.com", KEY, {
    safeFetch: (async () => {
      throw new SsrfBlockedError("Private IP");
    }) as any,
  });
  assert.equal(status, "unreachable");

  status = await checkKeyFile("example.com", KEY, {
    safeFetch: (async () => {
      throw new AppError(422, "url_blocked", "Blocked host");
    }) as any,
  });
  assert.equal(status, "unreachable");
});

test("keyFileProblem copy matches spec §6.2.2", () => {
  assert.equal(
    keyFileProblem("example.com", "missing"),
    "No key file at the root of https://example.com. Upload it there, then try again."
  );
  assert.equal(
    keyFileProblem("example.com", "wrong_content"),
    "The key file on https://example.com should contain only the key."
  );
  assert.equal(
    keyFileProblem("example.com", "redirects"),
    "The key file on https://example.com redirects. Upload it to https://example.com itself."
  );
  assert.equal(
    keyFileProblem("example.com", "moved"),
    "The key file on https://example.com redirects. Upload it to https://example.com itself."
  );
  assert.equal(keyFileProblem("example.com", "found"), null);
  assert.equal(keyFileProblem("example.com", "unknown"), null);
  assert.equal(keyFileProblem("example.com", "unreachable"), null);
});

test("checkKeyFiles throws 409 indexnow_not_set_up if no key is set", async () => {
  const admin: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  };

  const ws = { brandKey: "b1", brand: { website_host: "example.com" } };
  await assert.rejects(
    () => checkKeyFiles(admin, ws, { force: false }),
    (err: unknown) => err instanceof AppError && err.status === 409 && err.code === "indexnow_not_set_up"
  );
});

test("checkKeyFiles returns cached result within 60s when not force", async () => {
  let safeFetchCalled = false;
  const now = new Date("2026-10-22T10:00:30.000Z");
  const admin: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              key: KEY,
              last_check: [
                { host: "example.com", status: "found" },
                { host: "www.example.com", status: "moved" },
              ],
              last_checked_at: "2026-10-22T10:00:00.000Z",
            },
            error: null,
          }),
        }),
      }),
    }),
  };

  const ws = { brandKey: "b1", brand: { website_host: "example.com" } };
  const res = await checkKeyFiles(admin, ws, { force: false }, {
    now,
    safeFetch: (async () => {
      safeFetchCalled = true;
      return mockSafeFetchResult(200, KEY);
    }) as any,
  });

  assert.equal(res.cached, true);
  assert.equal(safeFetchCalled, false);
  assert.equal(res.hosts.length, 2);
});

test("checkKeyFiles performs check, inserts checks, updates keys, and logs cleanly", async () => {
  const insertedChecks: any[] = [];
  let updatedKeys: any = null;

  const admin: any = {
    from: (table: string) => {
      if (table === "indexnow_keys") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  key: KEY,
                  last_check: null,
                  last_checked_at: null,
                },
                error: null,
              }),
            }),
          }),
          update: (payload: any) => ({
            eq: () => {
              updatedKeys = payload;
              return { error: null };
            },
          }),
        };
      }
      if (table === "indexnow_key_checks") {
        return {
          insert: async (rows: any[]) => {
            insertedChecks.push(...rows);
            return { error: null };
          },
        };
      }
      return {};
    },
    rpc: async () => ({
      data: {
        checksLastHour: 0,
        oldestCheckInHour: null,
      },
      error: null,
    }),
  };

  const safeFetchMock: any = async (url: string) => {
    if (url.includes("www.")) {
      return mockSafeFetchResult(404, "Not Found");
    }
    return mockSafeFetchResult(200, KEY);
  };

  const now = new Date("2026-10-22T12:00:00.000Z");
  const ws = { brandKey: "b1", brand: { website_host: "example.com" } };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));

  try {
    const res = await checkKeyFiles(admin, ws, { force: false }, {
      now,
      safeFetch: safeFetchMock,
    });

    assert.equal(res.cached, false);
    assert.deepEqual(res.hosts, [
      { host: "example.com", status: "found" },
      { host: "www.example.com", status: "missing" },
    ]);
    assert.equal(insertedChecks.length, 2);
    assert.equal(updatedKeys?.last_check?.length, 2);
    assert.equal(updatedKeys?.last_checked_at, now.toISOString());

    // Check log output: must not contain key, host or url
    assert.ok(logs.some((l) => l.includes("[indexnow] check brand=b1 hosts=2 found=1")));
    for (const line of logs) {
      assert.ok(!line.includes(KEY));
      assert.ok(!line.includes("example.com"));
    }
  } finally {
    console.log = originalLog;
  }
});
