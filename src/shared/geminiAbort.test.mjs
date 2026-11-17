/**
 * R6.5.6 (finding A1) — the abort signal must actually reach the SDK's fetch.
 *
 * The shipped call was `model.generateContent(prompt, { requestOptions })`.
 * @google/generative-ai@0.24.1 takes `requestOptions` DIRECTLY as the second
 * argument, so the wrapper hid it: `buildFetchOptions` saw an object with
 * neither `signal` nor `timeout`, produced `{}`, and the fetch init came out as
 * `method, headers, body` with NO signal. The AbortController was inert and
 * `Promise.race` was the only timeout — the request was ABANDONED, not
 * cancelled, and with the five-model ladder x 3 attempts up to 15 requests
 * could outlive the call that started them.
 *
 * These tests stub globalThis.fetch. They make no network call and need no key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { generateContent, COST_STATE } from "./gemini.js";

/**
 * R3.6.5 widened the no-completion return from the bare pair
 * `{ text: "", model_used: "" }` to one that also says a cost could not be
 * measured. The two assertions below used to be `deepEqual` on that pair, which
 * pinned an incidental shape; they now assert the same two fields plus the
 * cost verdict, so they still fail if the ladder ever starts claiming a rung
 * answered — and additionally fail if a dead ladder is ever priced at $0.
 */
function assertDeadLadder(out, message) {
  assert.equal(out.text, "", message);
  assert.equal(out.model_used, "", `${message}: no rung may be named`);
  assert.equal(out.cost, null, `${message}: a dead ladder has no cost, not a $0 one`);
  assert.equal(out.cost_state, COST_STATE.PROBE_FAILED, `${message}: and must say so`);
}

process.env.GEMINI_API_KEY = "test-key-never-sent-anywhere";

// An unhandled rejection would take a long-lived worker (R1.2) down. Record
// them so the ladder test can ASSERT there were none, instead of relying on the
// runner crashing with a message nobody can attribute.
const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

const abortError = () => new DOMException("This operation was aborted", "AbortError");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function until(pred, label, budgetMs = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > budgetMs) throw new Error(`timed out waiting for: ${label}`);
    await tick(5);
  }
}

/**
 * Replaces globalThis.fetch. Every call is recorded with the exact init keys
 * the SDK produced, and each hangs until its signal aborts (if it has one) —
 * i.e. a request that is never cancelled is never torn down, which is the leak.
 */
function installFetchStub() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const record = {
      url: String(url),
      init,
      keys: Object.keys(init || {}),
      abortEvents: 0,
      rejectedWith: null,
      settled: false,
    };
    calls.push(record);
    const signal = init && init.signal;
    if (signal) signal.addEventListener("abort", () => { record.abortEvents += 1; });
    return new Promise((_resolve, reject) => {
      const fail = () => {
        record.settled = true;
        record.rejectedWith = "AbortError";
        reject(abortError());
      };
      if (!signal) return; // no signal => nothing can ever stop this request
      if (signal.aborted) return fail();
      signal.addEventListener("abort", fail);
    });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

/**
 * Captures the SECOND ARGUMENT gemini.js hands the SDK, by wrapping the model
 * the real client returns.
 */
function captureSdkArgs() {
  const calls = [];
  const orig = GoogleGenerativeAI.prototype.getGenerativeModel;
  GoogleGenerativeAI.prototype.getGenerativeModel = function (modelParams, ...rest) {
    const model = orig.call(this, modelParams, ...rest);
    const realGenerate = model.generateContent.bind(model);
    model.generateContent = (request, secondArg) => {
      calls.push({ model: modelParams && modelParams.model, secondArg });
      return realGenerate(request, secondArg);
    };
    return model;
  };
  return { calls, restore() { GoogleGenerativeAI.prototype.getGenerativeModel = orig; } };
}

// ---------------------------------------------------------------------------
// 1-2. The SDK contract itself, pinned. These two are the reproduction: they
// show the shipped shape is inert and the flat shape is not, at v0.24.1.
// ---------------------------------------------------------------------------

test("SDK contract: the shipped `{ requestOptions }` wrapper puts NO signal on the fetch init", async () => {
  const stub = installFetchStub();
  try {
    const model = new GoogleGenerativeAI("k").getGenerativeModel({ model: "gemini-2.5-flash-lite" });
    const controller = new AbortController();
    const requestOptions = { timeout: 20000, signal: controller.signal };

    // The exact shape that shipped at src/shared/gemini.js:46.
    model.generateContent("hi", { requestOptions }).catch(() => {});
    await until(() => stub.calls.length === 1, "the wrapped call to reach fetch");

    assert.deepEqual(
      stub.calls[0].keys.sort(),
      ["body", "headers", "method"],
      "the wrapper hides requestOptions: the init carries no signal at all"
    );
    assert.equal(stub.calls[0].init.signal, undefined);

    controller.abort();
    await tick(20);
    assert.equal(stub.calls[0].abortEvents, 0, "nothing is listening — the controller is inert");
    assert.equal(stub.calls[0].settled, false, "the upstream request is abandoned, never cancelled");
  } finally {
    stub.restore();
  }
});

test("SDK contract: requestOptions passed DIRECTLY relays the caller's signal, and aborting it tears the fetch down", async () => {
  const stub = installFetchStub();
  try {
    const model = new GoogleGenerativeAI("k").getGenerativeModel({ model: "gemini-2.5-flash-lite" });
    const controller = new AbortController();

    // No `timeout` here, so a signal on the init can only have come from ours.
    const promise = model.generateContent("hi", { signal: controller.signal });
    await until(() => stub.calls.length === 1, "the flat call to reach fetch");

    const init = stub.calls[0].init;
    assert.ok(init.signal instanceof AbortSignal, "the init must carry a signal");
    assert.equal(init.signal.aborted, false, "and it must not be aborted before we abort");
    // The SDK wraps the caller signal in an internal controller, so identity is
    // impossible by construction; linkage is what makes it OUR signal.
    assert.notEqual(init.signal, controller.signal, "SDK 0.24.1 relays via its own controller");

    controller.abort();
    await assert.rejects(promise, (e) => /abort/i.test(e.message), "the request must fail as aborted");
    assert.equal(init.signal.aborted, true, "our abort propagated to the fetch signal");
    assert.equal(stub.calls[0].abortEvents, 1, "the fetch's abort listener fired");
    assert.equal(stub.calls[0].rejectedWith, "AbortError", "the upstream request was cancelled, not abandoned");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. The regression guard on gemini.js's own call shape.
// ---------------------------------------------------------------------------

test("gemini.js hands the SDK requestOptions FLAT — re-wrapping it as { requestOptions } fails here", async () => {
  const stub = installFetchStub();
  const sdk = captureSdkArgs();
  try {
    await generateContent("hi", { timeout: 40 }, 0);

    assert.equal(sdk.calls.length, 5, "one call per model in the fallback ladder");
    for (const call of sdk.calls) {
      const arg = call.secondArg;
      assert.ok(arg && typeof arg === "object", `${call.model}: a requestOptions object must be passed`);
      assert.equal(
        arg.requestOptions,
        undefined,
        `${call.model}: requestOptions must NOT be nested — { requestOptions } is inert at SDK 0.24.1`
      );
      assert.ok(arg.signal instanceof AbortSignal, `${call.model}: signal must be on the requestOptions itself`);
      assert.equal(
        arg.timeout,
        undefined,
        `${call.model}: the SDK's own timeout schedules a setTimeout(abort) it never clears — one stranded timer per rung`
      );
    }
  } finally {
    sdk.restore();
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 4-5. The signal on the init is the CALL'S controller, and it cancels.
// ---------------------------------------------------------------------------

test("gemini.js's own AbortController reaches fetch: the init carries a signal linked to it, and the request is cancelled", async () => {
  const stub = installFetchStub();
  const sdk = captureSdkArgs();
  try {
    await generateContent("hi", { timeout: 60 }, 0);

    assert.equal(stub.calls.length, 5, "every ladder rung reached fetch");
    for (let i = 0; i < stub.calls.length; i++) {
      const record = stub.calls[i];
      const ours = sdk.calls[i].secondArg.signal;
      // No `timeout` is passed, and buildFetchOptions only creates a signal when
      // `signal` or `timeout >= 0` is present — so a signal here can ONLY have
      // come from the call's own AbortController.
      assert.ok(
        record.keys.includes("signal"),
        `${sdk.calls[i].model}: the fetch init must carry the call's abort signal`
      );
      assert.notEqual(record.init.signal, ours, "relayed through the SDK's controller");
      assert.equal(ours.aborted, true, "the call's own controller aborted");
      assert.equal(record.init.signal.aborted, true, "and that abort reached the fetch signal");
      assert.equal(record.abortEvents, 1, "the fetch's abort listener fired");
      assert.equal(record.rejectedWith, "AbortError", "cancelled, not merely abandoned");
    }
  } finally {
    sdk.restore();
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. The ladder: one aborted attempt must not leave the previous ones running.
// ---------------------------------------------------------------------------

test("the fallback ladder leaves nothing in flight: every earlier attempt is torn down before the call returns", async () => {
  const stub = installFetchStub();
  try {
    const out = await generateContent("hi", { timeout: 40 }, 0);
    assertDeadLadder(out, "all five rungs failed");

    assert.equal(stub.calls.length, 5, "five models tried");
    const live = stub.calls.filter((c) => !c.settled);
    assert.deepEqual(
      live.map((c) => c.url.replace(/key=[^&]*/, "key=REDACTED")),
      [],
      "no request may outlive the call that started it"
    );
    for (const c of stub.calls) {
      assert.equal(c.abortEvents, 1, "each attempt was aborted exactly once");
    }

    await tick(10);
    await tick(10);
    assert.deepEqual(
      unhandled.map(String),
      [],
      "an attempt abandoned by Promise.race must still have its rejection handled — an unhandled one kills the worker"
    );
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 7-9. Teardown is not only about the socket: the deadline timers must go too,
// and a successful call must survive being torn down after it returns.
// ---------------------------------------------------------------------------

const countTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

test("a rung that fails fast leaves no timer behind — the 20s abort deadline is cleared when the ladder advances", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  // Fails immediately and for a reason that is NOT an abort, so nothing but the
  // explicit clearTimeout can retire this rung's deadline.
  globalThis.fetch = () => { calls += 1; return Promise.reject(new TypeError("connect ECONNREFUSED")); };
  try {
    const before = countTimers();
    const out = await generateContent("hi", {}, 0); // default 20_000ms deadline
    assertDeadLadder(out, "every rung refused the connection");
    assert.equal(calls, 5);
    assert.equal(
      countTimers() - before,
      0,
      "five rungs x (abort deadline + race deadline) must not be left pending for 20s each"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a successful call returns its text and leaves no timer behind, despite the teardown", async () => {
  const original = globalThis.fetch;
  const body = {
    candidates: [{ content: { parts: [{ text: "hello world" }], role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const before = countTimers();
    const stats = {};
    const out = await generateContent("hi", { stats }, 0);
    assert.equal(out.text, "hello world", "tearing the rung down must not eat the response");
    assert.equal(out.model_used, "gemini-2.5-flash-lite");
    assert.equal(out.tokens, 15);
    assert.equal(stats.tokens, 15, "usage still accrues");
    assert.equal(
      countTimers() - before,
      0,
      "the race deadline must be cleared on success too, not left pending for 20s"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("with three attempts the ladder still ends with zero live requests (15 attempts, 15 teardowns)", async () => {
  const stub = installFetchStub();
  try {
    await generateContent("hi", { timeout: 20 }, 2);
    assert.equal(stub.calls.length, 15, "5 models x 3 attempts");
    assert.equal(stub.calls.filter((c) => c.settled).length, 15, "all fifteen torn down, none left leaking");
  } finally {
    stub.restore();
  }
});
