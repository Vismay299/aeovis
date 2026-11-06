import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  LOOPS_BASE_URL,
  LoopsError,
  updateLoopsContact,
  sendLoopsEvent,
  sendLoopsTransactional,
  getContactNameParts,
  loopsIdempotencyKey,
} from "./client.ts";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures/f25");

async function loadFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES_DIR, name), "utf8");
}

test("updateLoopsContact sends PUT with correct URL, headers, and body", async () => {
  const recorded: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    recorded.push({ url: String(input), init });
    return new Response(await loadFixture("loops-ok.json"), { status: 200 });
  };

  await updateLoopsContact(
    {
      apiKey: "test-loops-key",
      payload: {
        email: "alice@example.test",
        userId: "user-123",
        firstName: "Alice",
        lastName: "Smith",
        source: "perceev-signup",
        subscribed: true,
        userGroup: "app-user",
        mailingLists: { list_1: true },
        workspaceCreated: true,
      },
    },
    { fetch: fakeFetch },
  );

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].url, `${LOOPS_BASE_URL}/contacts/update`);
  assert.equal(recorded[0].init?.method, "PUT");
  assert.deepEqual(
    (recorded[0].init?.headers as Record<string, string>)["Authorization"],
    "Bearer test-loops-key",
  );
  assert.deepEqual(
    (recorded[0].init?.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
  const parsedBody = JSON.parse(String(recorded[0].init?.body));
  assert.equal(parsedBody.email, "alice@example.test");
  assert.equal(parsedBody.userId, "user-123");
  assert.equal(parsedBody.firstName, "Alice");
  assert.equal(parsedBody.lastName, "Smith");
  assert.equal(parsedBody.workspaceCreated, true);
});

test("sendLoopsEvent sends POST with Idempotency-Key and payload", async () => {
  const recorded: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    recorded.push({ url: String(input), init });
    return new Response(await loadFixture("loops-ok.json"), { status: 200 });
  };

  const res = await sendLoopsEvent(
    {
      apiKey: "test-loops-key",
      payload: {
        email: "bob@example.test",
        userId: "user-456",
        eventName: "signed_up",
        eventProperties: { source: "google" },
      },
      idempotencyKey: "evt-idem-key-1",
    },
    { fetch: fakeFetch },
  );

  assert.equal(res.duplicate, false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].url, `${LOOPS_BASE_URL}/events/send`);
  assert.equal(recorded[0].init?.method, "POST");
  assert.equal(
    (recorded[0].init?.headers as Record<string, string>)["Idempotency-Key"],
    "evt-idem-key-1",
  );
  const body = JSON.parse(String(recorded[0].init?.body));
  assert.equal(body.eventName, "signed_up");
  assert.equal(body.userId, "user-456");
});

test("sendLoopsTransactional sends POST with addToAudience: false and Idempotency-Key", async () => {
  const recorded: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    recorded.push({ url: String(input), init });
    return new Response(await loadFixture("loops-ok.json"), { status: 200 });
  };

  const res = await sendLoopsTransactional(
    {
      apiKey: "test-loops-key",
      transactionalId: "tx-template-123",
      email: "carol@example.test",
      dataVariables: {
        brandName: "Acme Corp",
        scanDate: "22 Oct 2026",
      },
      idempotencyKey: "tx-idem-key-999",
    },
    { fetch: fakeFetch },
  );

  assert.equal(res.duplicate, false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].url, `${LOOPS_BASE_URL}/transactional`);
  assert.equal(recorded[0].init?.method, "POST");
  assert.equal(
    (recorded[0].init?.headers as Record<string, string>)["Idempotency-Key"],
    "tx-idem-key-999",
  );
  const body = JSON.parse(String(recorded[0].init?.body));
  assert.equal(body.transactionalId, "tx-template-123");
  assert.equal(body.email, "carol@example.test");
  assert.equal(body.addToAudience, false);
  assert.equal(body.dataVariables.brandName, "Acme Corp");
});

test("409 response is treated as success with duplicate: true", async () => {
  const fakeFetch: typeof fetch = async () => {
    return new Response(await loadFixture("loops-409.json"), { status: 409 });
  };

  const eventRes = await sendLoopsEvent(
    {
      apiKey: "test-loops-key",
      payload: { email: "dave@example.test", userId: "u-789", eventName: "signed_up" },
      idempotencyKey: "idem-dup",
    },
    { fetch: fakeFetch },
  );
  assert.equal(eventRes.duplicate, true);

  const txRes = await sendLoopsTransactional(
    {
      apiKey: "test-loops-key",
      transactionalId: "tx-1",
      email: "dave@example.test",
      dataVariables: {},
      idempotencyKey: "idem-dup-tx",
    },
    { fetch: fakeFetch },
  );
  assert.equal(txRes.duplicate, true);
});

test("429, 500, 400 throw LoopsError with corresponding code", async () => {
  const fakeFetch429: typeof fetch = async () => {
    return new Response(await loadFixture("loops-429.json"), { status: 429 });
  };
  await assert.rejects(
    async () => {
      await sendLoopsTransactional(
        {
          apiKey: "key",
          transactionalId: "tx-1",
          email: "test@example.test",
          dataVariables: {},
          idempotencyKey: "key-1",
        },
        { fetch: fakeFetch429 },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopsError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "rate_limited");
      return true;
    },
  );

  const fakeFetch500: typeof fetch = async () => {
    return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
  };
  await assert.rejects(
    async () => {
      await updateLoopsContact(
        {
          apiKey: "key",
          payload: { email: "test@example.test", userId: "u-1" },
        },
        { fetch: fakeFetch500 },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopsError);
      assert.equal(err.status, 500);
      assert.equal(err.code, "server");
      return true;
    },
  );

  const fakeFetch400: typeof fetch = async () => {
    return new Response(await loadFixture("loops-400.json"), { status: 400 });
  };
  await assert.rejects(
    async () => {
      await sendLoopsEvent(
        {
          apiKey: "key",
          payload: { email: "test@example.test", userId: "u-1", eventName: "bad_event" },
          idempotencyKey: "key-2",
        },
        { fetch: fakeFetch400 },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopsError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "rejected");
      return true;
    },
  );
});

test("abort after timeoutMs: 5 throws LoopsError with code timeout", async () => {
  const slowFetch: typeof fetch = async (_input, init) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        reject(err);
      });
    });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  await assert.rejects(
    async () => {
      await updateLoopsContact(
        {
          apiKey: "key",
          payload: { email: "test@example.test", userId: "u-1" },
        },
        { fetch: slowFetch, timeoutMs: 5 },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopsError);
      assert.equal(err.code, "timeout");
      return true;
    },
  );
});

test("console.warn spy never receives an @ character on failure", async () => {
  const originalWarn = console.warn;
  const loggedArgs: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    loggedArgs.push(args);
  };

  const fakeFetch400: typeof fetch = async () => {
    return new Response(await loadFixture("loops-400.json"), { status: 400 });
  };

  try {
    await assert.rejects(async () => {
      await sendLoopsTransactional(
        {
          apiKey: "key",
          transactionalId: "tx-secret",
          email: "super-secret-user@example.test",
          dataVariables: { user: "secret@example.test" },
          idempotencyKey: "tx-warn-test",
        },
        { fetch: fakeFetch400 },
      );
    });

    assert.ok(loggedArgs.length > 0);
    for (const call of loggedArgs) {
      const rendered = JSON.stringify(call);
      assert.ok(
        !rendered.includes("@"),
        `console.warn must not leak an email address: ${rendered}`,
      );
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("loopsIdempotencyKey: short raw kept, 150 chars starts with h: and is 66 chars", () => {
  assert.equal(loopsIdempotencyKey("short-key"), "short-key");
  const longKey = "x".repeat(150);
  const hashed = loopsIdempotencyKey(longKey);
  assert.equal(hashed.startsWith("h:"), true);
  assert.equal(hashed.length, 66);
});

test("getContactNameParts matches OpenSEO test cases", () => {
  assert.deepEqual(getContactNameParts(null), {});
  assert.deepEqual(getContactNameParts(undefined), {});
  assert.deepEqual(getContactNameParts(""), {});
  assert.deepEqual(getContactNameParts("   "), {});
  assert.deepEqual(getContactNameParts("Alice"), { firstName: "Alice" });
  assert.deepEqual(getContactNameParts("Alice Smith"), {
    firstName: "Alice",
    lastName: "Smith",
  });
  assert.deepEqual(getContactNameParts("  Alice   Mary   Smith  "), {
    firstName: "Alice",
    lastName: "Mary Smith",
  });
});
