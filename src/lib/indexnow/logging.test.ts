import test from "node:test";
import assert from "node:assert/strict";
import { submitUrls } from "./submit.ts";
import { checkKeyFiles } from "./keyFile.ts";

test("F19-AC-15: no console log line during check or submit contains a URL, host or key", async () => {
  const SECRET_KEY = "deadbeefcafebabedeadbeefcafebabe";
  const HOST = "sensitive-site.example.com";
  const TEST_URL = `https://${HOST}/private-path/new-page`;

  const logs: string[] = [];
  const capture = (...args: any[]) => {
    logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  };

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origInfo = console.info;

  console.log = capture;
  console.warn = capture;
  console.error = capture;
  console.info = capture;

  try {
    const admin: any = {
      from: (table: string) => {
        if (table === "indexnow_keys") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    key: SECRET_KEY,
                    last_check: null,
                    last_checked_at: null,
                  },
                  error: null,
                }),
              }),
            }),
            update: () => ({
              eq: async () => ({ error: null }),
            }),
          };
        }
        if (table === "indexnow_key_checks") {
          return {
            insert: async () => ({ error: null }),
          };
        }
        if (table === "indexnow_submissions") {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({ data: [], error: null }),
              }),
            }),
            insert: async () => ({ error: null }),
          };
        }
        return {};
      },
      rpc: async (fn: string) => {
        if (fn === "indexnow_ensure_key") {
          return { data: [{ key: SECRET_KEY, created: false }], error: null };
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
          return { data: [], error: null };
        }
        return { data: null, error: null };
      },
    };

    const safeFetchMock: any = async () => ({
      url: `https://${HOST}/${SECRET_KEY}.txt`,
      status: 200,
      headers: new Headers(),
      text: () => SECRET_KEY,
    });

    const fetchImplMock: any = async () => new Response(null, { status: 200 });

    const ws = {
      brandKey: "brand-123",
      brand: { website_host: HOST },
      user: { id: "user-456" },
    };

    // 1. Run checkKeyFiles
    await checkKeyFiles(admin, ws, { force: true }, {
      safeFetch: safeFetchMock,
    });

    // 2. Run submitUrls
    await submitUrls(
      admin,
      ws,
      {
        urls: [TEST_URL],
        source: "settings",
        requestId: "99999999-9999-9999-9999-999999999999",
      },
      {
        safeFetch: safeFetchMock,
        fetchImpl: fetchImplMock,
      }
    );

    // Verify logs
    assert.ok(logs.length > 0, "logs were captured");
    for (const logLine of logs) {
      assert.ok(!logLine.includes(SECRET_KEY), `log leaked key: ${logLine}`);
      assert.ok(!logLine.includes(HOST), `log leaked host: ${logLine}`);
      assert.ok(!logLine.includes("/private-path/"), `log leaked URL: ${logLine}`);
    }

    // Verify allowed log line shapes (§4 F19-AC-15 & §6.7)
    assert.ok(logs.some((l) => l.includes("[indexnow] check brand=brand-123 hosts=")));
    assert.ok(logs.some((l) => l.includes("[indexnow] submit brand=brand-123 hosts=")));
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    console.info = origInfo;
  }
});
