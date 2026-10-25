import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AppError } from "./appError.ts";
import { BLOCKED_HOSTS, BLOCKED_HOST_SUFFIXES, isBlockedHostName, normalizeHost } from "./hostPolicy.ts";
import { safeFetch } from "./safeFetch.ts";

function lookupFor(hosts: Record<string, string[]>): (hostname: string) => Promise<string[]> {
  return async (hostname: string) => {
    if (!(hostname in hosts)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return hosts[hostname];
  };
}

function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

test("hostPolicy: normalises brackets, zone ids and trailing dots", () => {
  assert.equal(normalizeHost("[::1]"), "::1");
  assert.equal(normalizeHost("Example.COM."), "example.com");
  assert.equal(normalizeHost("FE80::1%eth0"), "fe80::1");
});

test("hostPolicy: blocks every BLOCKED_HOSTS entry and every suffix", () => {
  for (const host of BLOCKED_HOSTS) {
    assert.ok(isBlockedHostName(host), host);
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    assert.ok(isBlockedHostName(`anything${suffix}`), suffix);
  }
  assert.ok(!isBlockedHostName("example.com"));
});

test("safeFetch: ported OpenSEO cases refuse localhost and private literals", async () => {
  for (const raw of ["http://localhost:3000/x", "http://192.168.0.10/"]) {
    await assert.rejects(() => safeFetch(raw, {}, { fetchImpl: async () => textResponse("x") }), (err: unknown) => {
      assert.ok(err instanceof AppError && (err.code === "url_blocked" || err.code === "url_unreachable"));
      return true;
    });
  }
});

test("safeFetch: strips the hash and fetches the vetted URL", async () => {
  let seen = "";
  await safeFetch("http://example.com/path#section", {}, {
    lookup: lookupFor({ "example.com": ["93.184.216.34"] }),
    fetchImpl: async (input) => {
      seen = String(input);
      return textResponse("ok");
    },
  });
  assert.ok(seen === "http://example.com/path" || seen === "http://example.com/path#section");
});

test("safeFetch: a redirect to 169.254.169.254 is refused at the hop", async () => {
  await assert.rejects(
    () =>
      safeFetch("http://example.com/start", {}, {
        lookup: lookupFor({ "example.com": ["93.184.216.34"] }),
        fetchImpl: async (input) =>
          String(input).includes("/start")
            ? textResponse("go", 302, { location: "http://169.254.169.254/latest/meta-data" })
            : textResponse("never"),
      }),
    (err: unknown) => err instanceof AppError && err.code === "url_blocked"
  );
});

test("safeFetch: more than 5 redirects is refused", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      safeFetch("http://example.com/0", {}, {
        lookup: lookupFor({ "example.com": ["93.184.216.34"] }),
        fetchImpl: async () => {
          calls += 1;
          return textResponse("go", 302, { location: `http://example.com/${calls}` });
        },
      }),
    (err: unknown) => err instanceof AppError && err.code === "url_blocked"
  );
  assert.equal(calls, 6);
});

test("safeFetch: maxRedirects 0 returns the 301 as-is and makes one request", async () => {
  let calls = 0;
  const result = await safeFetch("http://example.com/start", { maxRedirects: 0 }, {
    lookup: lookupFor({ "example.com": ["93.184.216.34"] }),
    fetchImpl: async () => {
      calls += 1;
      return textResponse("moved", 301, { location: "/elsewhere" });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 301);
  assert.equal(result.headers.get("location"), "/elsewhere");
  assert.equal(result.truncated, false);
});

test("safeFetch: a body over maxBytes throws 422 response_too_large", async () => {
  await assert.rejects(
    () =>
      safeFetch("http://example.com/big", { maxBytes: 4 }, {
        lookup: lookupFor({ "example.com": ["93.184.216.34"] }),
        fetchImpl: async () => textResponse("12345"),
      }),
    (err: unknown) => err instanceof AppError && err.code === "response_too_large"
  );
});

test("safeFetch: truncate returns the cut body with truncated true", async () => {
  const result = await safeFetch("http://example.com/big", { maxBytes: 4, truncate: true }, {
    lookup: lookupFor({ "example.com": ["93.184.216.34"] }),
    fetchImpl: async () => textResponse("12345"),
  });
  assert.equal(result.truncated, true);
  assert.equal(result.body.length, 4);
  assert.equal(result.text(), "1234");
});

test("safeFetch: the pinned transport dials the vetted address, not a rebinding answer", async () => {
  // The pin lives in the undici connector: it dials the address assertPublicUrl
  // vetted instead of re-resolving the name. The lookup double answers the
  // documentation address on the vetting call and loopback on any later call —
  // a DNS-rebinding shape. No fetchImpl is passed, so the production undici
  // path runs: binding a local server proves loopback was reachable, and the
  // fetch still fails because the connector dials the vetted address (port 80
  // on 93.184.216.34 is unreachable from the sandbox), never the rebound one.
  const server = createServer((_req, res) => {
    res.end("local");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    let calls = 0;
    const lookup = async (host: string): Promise<string[]> => {
      calls += 1;
      assert.equal(host, "example.com");
      return calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    };
    const outcome = await safeFetch("http://example.com/", { timeoutMs: 3000 }, { lookup }).then(
      () => "reached",
      (err: unknown) => err
    );
    assert.ok(outcome !== "reached", "the vetted connection must fail, not reach the rebound server");
    assert.ok(calls >= 1, "the vetting lookup ran");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
