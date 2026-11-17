import type { SupabaseClient } from "@supabase/supabase-js";
import { readUIMessageStream, type UIMessage } from "ai";

const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_POLL_MS = 500;
const DEFAULT_MAX_REPLAY_MS = 280_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export type PersistSseDeps = {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  flushMs?: number;
  maxBytes?: number;
};

/**
 * Stores the SSE frames of a streaming turn in `assistant_stream_chunks`,
 * batched so a reply is a handful of rows rather than one row per token.
 * A batch is written when it reaches 64 KiB, 250 ms after the first buffered
 * frame, or when the stream ends.
 */
export async function persistSseStream(
  admin: SupabaseClient,
  input: { turnId: string; brandKey: string },
  stream: ReadableStream<string>,
  deps: PersistSseDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((handle: TimerHandle) => clearTimeout(handle));
  const flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  let seq = 0;
  let buffer: string[] = [];
  let bytes = 0;
  let timer: TimerHandle | null = null;
  let pending: Promise<void> = Promise.resolve();
  let failure: unknown = null;

  const clearTimer = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const write = async () => {
    if (buffer.length === 0) return;
    const data = buffer.join("");
    buffer = [];
    bytes = 0;
    const { error } = await admin
      .from("assistant_stream_chunks")
      .insert({ turn_id: input.turnId, seq, brand_key: input.brandKey, data });
    if (error) throw error;
    seq += 1;
  };

  const flush = async () => {
    clearTimer();
    await pending;
    if (failure) throw failure;
    await write();
  };

  const onTimer = () => {
    timer = null;
    pending = pending.then(write).catch((error) => {
      failure = error;
    });
  };

  const arm = () => {
    if (timer !== null) return;
    timer = schedule(onTimer, flushMs);
  };

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (typeof value !== "string" || value.length === 0) continue;
      buffer.push(value);
      bytes += Buffer.byteLength(value, "utf8");
      arm();
      if (bytes >= maxBytes) await flush();
      if (failure) throw failure;
      if (timer === null && buffer.length > 0) arm();
    }
    await flush();
  } finally {
    clearTimer();
    reader.releaseLock();
  }
}

export type ReplayOptions = {
  /** Last seq the caller already received; replay starts after it. */
  cursor?: number;
  pollMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  isStreaming?: () => Promise<boolean>;
};

/**
 * Replays every stored chunk after `cursor` in order, then tails new ones until
 * the turn stops streaming (or the 280 s cap). With no streaming turn and no
 * rows the stream closes immediately, which the route turns into a 204.
 */
export function replayTurnStream(
  admin: SupabaseClient,
  turnId: string,
  options: ReplayOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_REPLAY_MS;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isStreaming =
    options.isStreaming ??
    (async () => {
      const { data, error } = await admin
        .from("assistant_turns")
        .select("status")
        .eq("id", turnId)
        .maybeSingle();
      if (error) throw error;
      return (data as { status?: string } | null)?.status === "streaming";
    });

  let cursor = options.cursor ?? -1;
  let cancelled = false;
  const startedAt = now();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          if (cancelled || options.signal?.aborted) {
            controller.close();
            return;
          }
          const { data, error } = await admin
            .from("assistant_stream_chunks")
            .select("seq,data")
            .eq("turn_id", turnId)
            .gt("seq", cursor)
            .order("seq", { ascending: true });
          if (error) throw error;
          const rows = Array.isArray(data) ? (data as Array<{ seq: number; data: string }>) : [];
          for (const row of rows) {
            controller.enqueue(encoder.encode(String(row.data)));
            cursor = Number(row.seq);
          }
          const streaming = await isStreaming();
          if (!streaming) {
            if (rows.length === 0) {
              controller.close();
              return;
            }
            // One more immediate pass: a chunk may have landed between the
            // read and the status check.
            continue;
          }
          if (now() - startedAt >= maxMs) {
            controller.close();
            return;
          }
          await sleep(pollMs);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

/**
 * Rebuilds the UI message from stored SSE frames so an interrupted turn keeps
 * the reply the customer already saw. Returns null when nothing was stored.
 */
export async function rebuildAssistantMessage(chunks: string[]): Promise<UIMessage | null> {
  const frames: unknown[] = [];
  for (const line of chunks.join("").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      // A truncated final frame is expected when a turn was killed mid-write.
      continue;
    }
  }
  if (frames.length === 0) return null;
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });
  let last: UIMessage | null = null;
  for await (const message of readUIMessageStream({ stream: stream as ReadableStream<never> })) {
    last = message as UIMessage;
  }
  return last;
}
