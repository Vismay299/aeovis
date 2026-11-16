import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { persistSseStream, rebuildAssistantMessage, replayTurnStream } from "./streamStore.ts";

type Row = Record<string, any>;

function makeAdmin(seed: { chunks?: Row[]; turns?: Row[] } = {}) {
  const tables = {
    assistant_stream_chunks: (seed.chunks ?? []).map((row) => ({ ...row })),
    assistant_turns: (seed.turns ?? []).map((row) => ({ ...row })),
  };

  function query(table: keyof typeof tables) {
    const filters: Array<[string, any, string]> = [];
    const orders: Array<[string, boolean]> = [];
    let inserted: Row | null = null;
    const run = () => {
      const rows = tables[table];
      if (inserted) {
        rows.push({ ...inserted });
        return { data: [{ ...inserted }], error: null };
      }
      let out = rows.filter((row) =>
        filters.every(([column, value, op]) => {
          if (op === "gt") return row[column] > value;
          return row[column] === value;
        }),
      );
      if (orders.length > 0) {
        out = out.slice().sort((a, b) => {
          for (const [column, ascending] of orders) {
            if (a[column] < b[column]) return ascending ? -1 : 1;
            if (a[column] > b[column]) return ascending ? 1 : -1;
          }
          return 0;
        });
      }
      return { data: out.map((row) => ({ ...row })), error: null };
    };
    const builder: any = {
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value, "eq"]);
        return builder;
      },
      gt(column: string, value: unknown) {
        filters.push([column, value, "gt"]);
        return builder;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orders.push([column, opts?.ascending !== false]);
        return builder;
      },
      insert(row: Row) {
        inserted = row;
        return builder;
      },
      maybeSingle() {
        const result = run();
        return Promise.resolve({ data: result.data[0] ?? null, error: null });
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  }

  return { admin: { from: (table: keyof typeof tables) => query(table) } as any, tables };
}

function controllable() {
  let controller: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({
    start(next) {
      controller = next;
    },
  });
  return {
    stream,
    push(value: string) {
      controller.enqueue(value);
    },
    close() {
      controller.close();
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeTimers() {
  const scheduled: Array<() => void> = [];
  return {
    scheduled,
    deps: {
      setTimeout: ((fn: () => void) => {
        scheduled.push(fn);
        return scheduled.length as any;
      }) as any,
      clearTimeout: (() => {}) as any,
      now: () => 0,
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

test("persistSseStream batches by time and writes seq 0..n", async () => {
  const { admin, tables } = makeAdmin();
  const timers = fakeTimers();
  const source = controllable();
  const done = persistSseStream(admin, { turnId: "t1", brandKey: "brand-a" }, source.stream, timers.deps);

  source.push("data: a\n\n");
  await tick();
  assert.equal(timers.scheduled.length, 1, "the first frame arms the flush timer");
  timers.scheduled[0]();
  await tick();
  assert.equal(tables.assistant_stream_chunks.length, 1);
  assert.equal(tables.assistant_stream_chunks[0].seq, 0);
  assert.equal(tables.assistant_stream_chunks[0].data, "data: a\n\n");

  source.push("data: b\n\n");
  await tick();
  assert.equal(timers.scheduled.length, 2);
  timers.scheduled[1]();
  await tick();
  source.push("data: c\n\n");
  await tick();
  timers.scheduled[2]();
  source.close();
  await done;

  assert.deepEqual(
    tables.assistant_stream_chunks.map((row) => [row.seq, row.data]),
    [
      [0, "data: a\n\n"],
      [1, "data: b\n\n"],
      [2, "data: c\n\n"],
    ],
  );
  assert.ok(tables.assistant_stream_chunks.every((row) => row.brand_key === "brand-a" && row.turn_id === "t1"));
});

test("persistSseStream flushes at 64 KiB rather than per frame", async () => {
  const { admin, tables } = makeAdmin();
  const timers = fakeTimers();
  const source = controllable();
  const done = persistSseStream(admin, { turnId: "t1", brandKey: "brand-a" }, source.stream, {
    ...timers.deps,
    maxBytes: 64,
  });

  source.push("A".repeat(40));
  await tick();
  assert.equal(tables.assistant_stream_chunks.length, 0, "40 bytes stay buffered");
  source.push("B".repeat(40));
  await tick();
  assert.equal(tables.assistant_stream_chunks.length, 1, "80 bytes cross the 64-byte cap in one row");
  assert.equal(tables.assistant_stream_chunks[0].seq, 0);
  assert.equal(tables.assistant_stream_chunks[0].data, "A".repeat(40) + "B".repeat(40));

  source.push("C".repeat(10));
  await tick();
  timers.scheduled[0]();
  source.close();
  await done;
  assert.deepEqual(
    tables.assistant_stream_chunks.map((row) => [row.seq, row.data.length]),
    [
      [0, 80],
      [1, 10],
    ],
  );
});

test("persistSseStream writes nothing for an empty turn", async () => {
  const { admin, tables } = makeAdmin();
  const source = controllable();
  const done = persistSseStream(admin, { turnId: "t1", brandKey: "brand-a" }, source.stream, fakeTimers().deps);
  source.close();
  await done;
  assert.equal(tables.assistant_stream_chunks.length, 0);
});

test("replayTurnStream replays chunks after the cursor in order and ends when the turn stops", async () => {
  const { admin } = makeAdmin({
    chunks: [
      { turn_id: "t1", seq: 0, data: "s0" },
      { turn_id: "t1", seq: 1, data: "s1" },
      { turn_id: "t1", seq: 2, data: "s2" },
    ],
  });
  const text = await collect(
    replayTurnStream(admin, "t1", { isStreaming: async () => false, sleep: async () => {} }),
  );
  assert.equal(text, "s0s1s2");

  const afterCursor = await collect(
    replayTurnStream(admin, "t1", { cursor: 1, isStreaming: async () => false, sleep: async () => {} }),
  );
  assert.equal(afterCursor, "s2");
});

test("replayTurnStream tails new chunks while the turn is streaming", async () => {
  const { admin, tables } = makeAdmin({
    chunks: [{ turn_id: "t1", seq: 0, data: "first" }],
  });
  let polls = 0;
  const text = await collect(
    replayTurnStream(admin, "t1", {
      isStreaming: async () => {
        polls += 1;
        return polls < 3;
      },
      sleep: async () => {
        if (tables.assistant_stream_chunks.length === 1) {
          tables.assistant_stream_chunks.push({ turn_id: "t1", seq: 1, data: "second" });
        }
      },
    }),
  );
  assert.equal(text, "firstsecond");
});

test("replayTurnStream closes empty when nothing is streaming and nothing is stored", async () => {
  const { admin } = makeAdmin();
  const text = await collect(replayTurnStream(admin, "t1", { isStreaming: async () => false }));
  assert.equal(text, "");
});

test("replayTurnStream stops at the time budget even while the turn streams", async () => {
  const { admin } = makeAdmin();
  let clock = 0;
  const text = await collect(
    replayTurnStream(admin, "t1", {
      isStreaming: async () => true,
      sleep: async () => {
        clock += 1_000;
      },
      now: () => clock,
      maxMs: 2_500,
      pollMs: 1,
    }),
  );
  assert.equal(text, "");
  assert.ok(clock >= 2_500);
});

test("rebuildAssistantMessage folds the synthetic SSE fixture into text plus one tool part", async () => {
  const fixture = readFileSync(new URL("../../../tests/fixtures/f22/sse-turn.txt", import.meta.url), "utf8");
  // Chunk boundaries are arbitrary in the database: split mid-frame to prove
  // the rebuild joins first and parses lines after.
  const chunks: string[] = [];
  for (let at = 0; at < fixture.length; at += 37) chunks.push(fixture.slice(at, at + 37));
  const message = await rebuildAssistantMessage(chunks);

  assert.ok(message);
  assert.equal(message.id, "a_f22fixture0000000000000000000001");
  assert.equal(message.role, "assistant");
  assert.equal(message.parts.length, 2);
  const text = message.parts[0] as any;
  assert.equal(text.type, "text");
  assert.equal(
    text.text,
    "Your latest scan answered 9 of 12 questions. Acme Tees is named in 7 of them; acme.example is the most cited source.",
  );
  assert.equal(text.state, "done");
  const tool = message.parts[1] as any;
  assert.equal(tool.type, "tool-list_scans");
  assert.equal(tool.state, "output-available");
  assert.deepEqual(tool.input, { limit: 5 });
  assert.equal(tool.output.status, "success");
  assert.equal(tool.output.summary, "1 scan.");
  assert.equal(tool.output.data.totalCount, 1);
  assert.equal(tool.output.link.path, "/portal/scans");
  assert.deepEqual(message.metadata, {
    turnId: "f22fixture-turn",
    model: "qa/fixture",
    costUsd: 0.0021,
    costKnown: true,
  });
});

test("rebuildAssistantMessage tolerates empty input, junk and a truncated last frame", async () => {
  assert.equal(await rebuildAssistantMessage([]), null);
  assert.equal(await rebuildAssistantMessage(["not an sse frame"]), null);
  const partial =
    'data: {"type":"start","messageId":"a_partial"}\n\n' +
    'data: {"type":"text-start","id":"t"}\n\n' +
    'data: {"type":"text-delta","id":"t","delta":"kept"}\n\n' +
    'data: {"type":"text-end","id":"t"}\n\n' +
    'data: {"type":"text-delta","id":"t","del';
  const message = await rebuildAssistantMessage([partial]);
  assert.ok(message);
  assert.equal((message.parts[0] as any).text, "kept");
});
