import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AHREFS_DR_ENDPOINT,
  getAhrefsDomainRatings,
} from "./ahrefsDomainRating.ts";
import { createMemoryCacheStore } from "../cache/memoryStore.ts";
import { AppError } from "../http/appError.ts";

function loadFixture(name: string): unknown {
  const url = new URL(`../../../tests/fixtures/f16/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("www and protocol variants resolve once and fan out to both keys", async () => {
  const store = createMemoryCacheStore();
  const urls: string[] = [];
  let fetchCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    fetchCalls++;
    urls.push(String(url));
    return jsonResponse(loadFixture("ahrefs-dr.json"));
  }) as typeof fetch;

  const ratings = await getAhrefsDomainRatings(
    ["www.bewakoof.com", "https://bewakoof.com"],
    { fetch: fetchImpl, cacheDeps: { store } },
  );

  assert.equal(fetchCalls, 1);
  assert.deepEqual(urls, [`${AHREFS_DR_ENDPOINT}?target=bewakoof.com`]);
  assert.equal(ratings["www.bewakoof.com"], 61);
  assert.equal(ratings["https://bewakoof.com"], 61);
});

test("invalid inputs map to null without a fetch", async () => {
  const store = createMemoryCacheStore();
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls++;
    return jsonResponse(loadFixture("ahrefs-dr.json"));
  }) as typeof fetch;

  const ratings = await getAhrefsDomainRatings(["!!!"], {
    fetch: fetchImpl,
    cacheDeps: { store },
  });

  assert.equal(ratings["!!!"], null);
  assert.equal(fetchCalls, 0);
});

test("at most 20 fetches are in flight and every URL uses the endpoint prefix", async () => {
  const store = createMemoryCacheStore();
  const urls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let fetchCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    fetchCalls++;
    urls.push(String(url));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return jsonResponse(loadFixture("ahrefs-dr.json"));
  }) as typeof fetch;

  const domains = Array.from({ length: 45 }, (_, i) => `site-${i + 1}.com`);
  const ratings = await getAhrefsDomainRatings(domains, {
    fetch: fetchImpl,
    cacheDeps: { store },
  });

  assert.equal(fetchCalls, 45);
  assert.ok(maxInFlight <= 20, `max in flight was ${maxInFlight}`);
  assert.ok(maxInFlight > 1, `expected parallel batches, got ${maxInFlight}`);
  for (const url of urls) {
    assert.ok(
      url.startsWith(`${AHREFS_DR_ENDPOINT}?target=`),
      `unexpected URL ${url}`,
    );
  }
  for (const domain of domains) {
    assert.equal(ratings[domain], 61);
  }
});

test("a 5s timeout returns null, is not cached, and the next call refetches", async () => {
  const store = createMemoryCacheStore();
  let fetchCalls = 0;
  const fetchHang = (async (_url: unknown, init?: { signal?: unknown }) => {
    fetchCalls++;
    const signal = init?.signal as AbortSignal | undefined;
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
  }) as unknown as typeof fetch;

  const first = await getAhrefsDomainRatings(["bewakoof.com"], {
    fetch: fetchHang,
    cacheDeps: { store },
  });
  assert.equal(first["bewakoof.com"], null);
  assert.equal(fetchCalls, 1);

  const second = await getAhrefsDomainRatings(["bewakoof.com"], {
    fetch: fetchHang,
    cacheDeps: { store },
  });
  assert.equal(second["bewakoof.com"], null);
  assert.equal(fetchCalls, 2);
});

test("DR 0 returns null and is cached", async () => {
  const store = createMemoryCacheStore();
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls++;
    return jsonResponse(loadFixture("ahrefs-dr-zero.json"));
  }) as typeof fetch;

  const first = await getAhrefsDomainRatings(["www.example.in"], {
    fetch: fetchImpl,
    cacheDeps: { store },
  });
  assert.equal(first["www.example.in"], null);
  assert.equal(fetchCalls, 1);

  const second = await getAhrefsDomainRatings(["www.example.in"], {
    fetch: fetchImpl,
    cacheDeps: { store },
  });
  assert.equal(second["www.example.in"], null);
  assert.equal(fetchCalls, 1);
});

test("a second call within 24h makes zero fetches", async () => {
  const store = createMemoryCacheStore();
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls++;
    return jsonResponse(loadFixture("ahrefs-dr.json"));
  }) as typeof fetch;

  const first = await getAhrefsDomainRatings(["bewakoof.com"], {
    fetch: fetchImpl,
    cacheDeps: { store },
  });
  assert.equal(first["bewakoof.com"], 61);
  assert.equal(fetchCalls, 1);

  const second = await getAhrefsDomainRatings(["bewakoof.com"], {
    fetch: fetchImpl,
    cacheDeps: { store },
  });
  assert.equal(second["bewakoof.com"], 61);
  assert.equal(fetchCalls, 1);
});

test("a failed fetch returns null and is not cached", async () => {
  const store = createMemoryCacheStore();
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls++;
    return jsonResponse({ error: "boom" }, 500);
  }) as typeof fetch;

  const first = await getAhrefsDomainRatings(["bewakoof.com"], {
    fetch: fetchImpl,
    cacheDeps: { store },
  });
  assert.equal(first["bewakoof.com"], null);
  assert.equal(fetchCalls, 1);

  const second = await getAhrefsDomainRatings(["bewakoof.com"], {
    fetch: fetchImpl,
    cacheDeps: { store },
  });
  assert.equal(second["bewakoof.com"], null);
  assert.equal(fetchCalls, 2);
});

test("more than 100 domains throws 400 invalid_request", async () => {
  const store = createMemoryCacheStore();
  const domains = Array.from({ length: 101 }, (_, i) => `site-${i + 1}.com`);
  await assert.rejects(
    getAhrefsDomainRatings(domains, { cacheDeps: { store } }),
    (err: unknown) =>
      err instanceof AppError && err.status === 400 && err.code === "invalid_request",
  );
});
