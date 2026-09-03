import test from "node:test";
import assert from "node:assert/strict";

import { scrapeForSummary } from "./firecrawl.js";
import { SsrfBlockedError, isPolicyRefusal } from "./ssrfGuard.js";

/**
 * R3.7.1 — the Firecrawl fallback is a server-side fetch of a URL that an
 * ANONYMOUS caller supplies (POST /api/scan -> scan_jobs.url -> scanWorker ->
 * generateUnbrandedPrompts -> scrapeForSummary). Before the guard, a target
 * like http://169.254.169.254/latest/meta-data/ was fetched and its body was
 * returned to the caller.
 *
 * Every fetch here is stubbed and every DNS lookup is injected. Nothing in
 * this file reaches the network, and no cloud metadata endpoint is contacted.
 */

const PUBLIC = async () => ["93.184.216.34"];

/** A fetch stub that records what it was asked to fetch. */
function makeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(url);
    // Whether or not FIRECRAWL_API_KEY is set in this environment, push the
    // vendor path aside so the test always exercises the fallback (the surface
    // under test). A 402 is exactly what the vendor returns with no balance.
    if (String(url).startsWith("https://api.firecrawl.dev/")) {
      return { ok: false, status: 402, async json() { return {}; } };
    }
    return handler(url, init);
  };
  return { impl, calls };
}

function htmlResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return body;
    },
  };
}

// ---------------------------------------------------------------------------
// The hole this task closes
// ---------------------------------------------------------------------------

const SSRF_TARGETS = [
  ["http://169.254.169.254/latest/meta-data/iam/security-credentials/", "link_local"],
  ["http://[fd00:ec2::254]/latest/meta-data/", "unique_local"],
  ["http://127.0.0.1:5432/", "loopback"],
  ["http://[::1]/", "loopback"],
  ["http://2130706433/", "loopback"],
  ["http://0x7f000001/", "loopback"],
  ["http://0177.0.0.1/", "loopback"],
  ["http://10.0.0.1/internal", "private"],
  ["http://192.168.1.1/", "private"],
  ["http://172.16.5.4/", "private"],
  ["http://0.0.0.0/", "this_network"],
  ["http://[::ffff:127.0.0.1]/", "ipv4_mapped_loopback"],
  ["file:///etc/passwd", "scheme"],
  ["gopher://127.0.0.1:6379/_INFO", "scheme"],
  ["ftp://127.0.0.1/", "scheme"],
  ["data:text/html,<h1>x</h1>", "scheme"],
];

for (const [target, code] of SSRF_TARGETS) {
  test(`scrapeForSummary refuses ${target} and never fetches it`, async () => {
    const { impl, calls } = makeFetch(() => {
      throw new Error("the guard let a blocked target through to fetch()");
    });
    await assert.rejects(
      () => scrapeForSummary(target, { fetchImpl: impl, lookup: PUBLIC }),
      (err) => {
        assert.ok(err instanceof SsrfBlockedError, `expected SsrfBlockedError, got ${err?.name}`);
        assert.equal(err.code, code);
        return true;
      }
    );
    assert.deepEqual(calls, [], "no fetch of any kind may happen for a refused target");
  });
}

test("a hostname that rebinds to loopback is refused before any fetch", async () => {
  const { impl, calls } = makeFetch(() => {
    throw new Error("should not fetch");
  });
  await assert.rejects(
    () => scrapeForSummary("https://rebind.example.com/", {
      fetchImpl: impl,
      lookup: async () => ["127.0.0.1"],
    }),
    (err) => {
      assert.equal(err.code, "loopback");
      return true;
    }
  );
  assert.deepEqual(calls, []);
});

test("a public page that redirects to the metadata address is refused at the hop", async () => {
  const fetched = [];
  const impl = async (url) => {
    fetched.push(url);
    if (String(url).startsWith("https://api.firecrawl.dev/")) {
      return { ok: false, status: 402, async json() { return {}; } };
    }
    return {
      ok: false,
      status: 302,
      headers: { get: (n) => (n.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data/" : null) },
      async text() { return ""; },
    };
  };

  await assert.rejects(
    () => scrapeForSummary("https://innocent.example.com/", { fetchImpl: impl, lookup: PUBLIC }),
    (err) => {
      assert.ok(err instanceof SsrfBlockedError);
      assert.equal(err.code, "link_local");
      return true;
    }
  );
  assert.ok(
    !fetched.some((u) => String(u).includes("169.254")),
    "the metadata address must never be requested"
  );
});

// ---------------------------------------------------------------------------
// A refusal must not look like an empty website (rule 1)
// ---------------------------------------------------------------------------

test("a refusal throws — it never degrades to the 'no content' string", async () => {
  const { impl } = makeFetch(() => htmlResponse("<html><body>x</body></html>"));
  let returned = null;
  try {
    returned = await scrapeForSummary("http://169.254.169.254/", { fetchImpl: impl, lookup: PUBLIC });
  } catch (err) {
    assert.ok(err instanceof SsrfBlockedError);
  }
  assert.equal(returned, null, "a blocked target must not return a value at all");
});

test("a name that does not resolve is unusable input, not a policy refusal", async () => {
  // No fetch happens either way — the distinction exists so a customer's typo
  // stays a 422 at /api/knowledge instead of becoming a 500.
  const { impl, calls } = makeFetch(() => {
    throw new Error("should not fetch an unresolvable name");
  });
  const out = await scrapeForSummary("https://nxdomain.example/", {
    fetchImpl: impl,
    lookup: async () => {
      const err = new Error("getaddrinfo ENOTFOUND");
      err.code = "ENOTFOUND";
      throw err;
    },
  });
  assert.equal(out, "No website content available.");
  assert.deepEqual(calls, [], "an unresolvable name must still never be fetched");
});

test("malformed input is unusable, not a policy refusal", async () => {
  const { impl, calls } = makeFetch(() => {
    throw new Error("should not fetch garbage");
  });
  const out = await scrapeForSummary("http://exa mple.com/", { fetchImpl: impl, lookup: PUBLIC });
  assert.equal(out, "No website content available.");
  assert.deepEqual(calls, []);
});

test("isPolicyRefusal separates a security block from unusable input", () => {
  assert.equal(isPolicyRefusal(new SsrfBlockedError("x", { code: "link_local" })), true);
  assert.equal(isPolicyRefusal(new SsrfBlockedError("x", { code: "loopback" })), true);
  assert.equal(isPolicyRefusal(new SsrfBlockedError("x", { code: "scheme" })), true);
  assert.equal(isPolicyRefusal(new SsrfBlockedError("x", { code: "credentials" })), true);
  assert.equal(isPolicyRefusal(new SsrfBlockedError("x", { code: "dns_failed" })), false);
  assert.equal(isPolicyRefusal(new SsrfBlockedError("x", { code: "malformed" })), false);
  assert.equal(isPolicyRefusal(new Error("boom")), false);
});

test("an ordinary network failure still degrades to the documented empty state", async () => {
  const { impl } = makeFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  const out = await scrapeForSummary("https://legit-customer.example/", {
    fetchImpl: impl,
    lookup: PUBLIC,
  });
  assert.equal(out, "No website content available.");
});

test("a 404 from a real site still degrades to the documented empty state", async () => {
  const { impl } = makeFetch(() => htmlResponse("not found", 404));
  const out = await scrapeForSummary("https://legit-customer.example/", {
    fetchImpl: impl,
    lookup: PUBLIC,
  });
  assert.equal(out, "No website content available.");
});

// ---------------------------------------------------------------------------
// A guard that blocks real customers is a worse outage than the bug
// ---------------------------------------------------------------------------

test("a legitimate customer URL is still scraped through the fallback", async () => {
  const { impl, calls } = makeFetch(() =>
    htmlResponse("<html><head><title>t</title></head><body><h1>Acme Analytics</h1><p>Dashboards for ops teams.</p></body></html>")
  );
  const out = await scrapeForSummary("https://acme-analytics.co.in", {
    fetchImpl: impl,
    lookup: PUBLIC,
  });
  assert.equal(out, "Acme Analytics Dashboards for ops teams.");
  assert.ok(
    calls.includes("https://acme-analytics.co.in/"),
    `expected the customer URL to be fetched, saw ${JSON.stringify(calls)}`
  );
});

test("a bare domain with no scheme still works", async () => {
  const { impl, calls } = makeFetch(() => htmlResponse("<html><body>Bare domain page</body></html>"));
  const out = await scrapeForSummary("acme-analytics.co.in", { fetchImpl: impl, lookup: PUBLIC });
  assert.equal(out, "Bare domain page");
  assert.ok(calls.includes("https://acme-analytics.co.in/"));
});

test("a legitimate redirect between public hosts is followed", async () => {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    if (String(url).startsWith("https://api.firecrawl.dev/")) {
      return { ok: false, status: 402, async json() { return {}; } };
    }
    if (seen.filter((u) => !String(u).startsWith("https://api.firecrawl.dev/")).length === 1) {
      return {
        ok: false,
        status: 301,
        headers: { get: (n) => (n.toLowerCase() === "location" ? "https://www.acme-analytics.co.in/" : null) },
        async text() { return ""; },
      };
    }
    return htmlResponse("<html><body>Canonical page</body></html>");
  };
  const out = await scrapeForSummary("https://acme-analytics.co.in", { fetchImpl: impl, lookup: PUBLIC });
  assert.equal(out, "Canonical page");
});

test("an empty website field is still the documented no-op, not a throw", async () => {
  assert.equal(await scrapeForSummary(""), "No website content available.");
  assert.equal(await scrapeForSummary(null), "No website content available.");
  assert.equal(await scrapeForSummary(undefined), "No website content available.");
});
