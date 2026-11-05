// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/tanstack-db/queryClient.ts
//   src/client/tanstack-db/queryClient.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
//
// F05-AC-01 — the shared client's defaults, retry rule and mutation toast.
// The toast is injected, so no module mocking is needed.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  QUERY_GC_TIME_MS,
  QUERY_STALE_TIME_MS,
  createQueryClient,
  shouldRetryQuery,
} from "./queryClient.ts";
import { ApiError } from "./fetchJson.ts";

type ToastCall = { title: string; description: string | undefined };

// The one-hour gcTime timers would keep the test process alive, so every
// client created here is cleared when the file is done.
const created: Array<ReturnType<typeof createQueryClient>> = [];
after(() => {
  for (const client of created) client.clear();
});

function setup() {
  const toasts: ToastCall[] = [];
  const client = createQueryClient({
    toastError: (title, description) => toasts.push({ title, description }),
  });
  created.push(client);
  return { client, toasts };
}

function runFailingMutation(
  client: ReturnType<typeof createQueryClient>,
  error: unknown,
  options: { onError?: () => void; meta?: { errorToast?: false } } = {},
) {
  return client
    .getMutationCache()
    .build(client, {
      mutationFn: () => Promise.reject(error),
      ...options,
    })
    .execute(undefined)
    .catch(() => undefined);
}

test("shows the error's message for a mutation without its own handling (exactly one toast)", async () => {
  const { client, toasts } = setup();
  await runFailingMutation(client, new Error("Too many requests. Please wait and try again."));
  assert.deepEqual(toasts, [
    { title: "Too many requests. Please wait and try again.", description: undefined },
  ]);
});

test("stays quiet when the mutation has its own onError or opts out", async () => {
  const { client, toasts } = setup();
  await runFailingMutation(client, new Error("RATE_LIMITED"), {
    onError: () => undefined,
  });
  await runFailingMutation(client, new Error("RATE_LIMITED"), {
    meta: { errorToast: false },
  });
  assert.equal(toasts.length, 0);
});

test("an ApiError mutation failure toasts its message once", async () => {
  const { client, toasts } = setup();
  await runFailingMutation(client, new ApiError(400, "validation_error", "Name is required."));
  assert.deepEqual(toasts, [{ title: "Name is required.", description: undefined }]);
});

test("a non-Error rejection toasts the default fallback", async () => {
  const { client, toasts } = setup();
  await runFailingMutation(client, "boom");
  assert.deepEqual(toasts, [
    { title: "Something went wrong. Please try again.", description: undefined },
  ]);
});

test("a 401 shows no toast", async () => {
  const { client, toasts } = setup();
  await runFailingMutation(client, new ApiError(401, "unauthenticated", "Please sign in."));
  assert.equal(toasts.length, 0);
});

test("a spend refusal toasts the card title with message and recovery", async () => {
  const { client, toasts } = setup();
  await runFailingMutation(
    client,
    new ApiError(403, "daily_cap", "Daily limit reached.", {
      recovery: "Try again tomorrow.",
    }),
  );
  assert.deepEqual(toasts, [
    {
      title: "Daily spend limit reached",
      description: "Daily limit reached. Try again tomorrow.",
    },
  ]);
});

test("a spend refusal without recovery has the message alone as description", async () => {
  const { client, toasts } = setup();
  await runFailingMutation(
    client,
    new ApiError(403, "feature_disabled", "This feature is not enabled for your workspace."),
  );
  assert.deepEqual(toasts, [
    {
      title: "Not available for this workspace",
      description: "This feature is not enabled for your workspace.",
    },
  ]);
});

test("a spend refusal still respects onError and the errorToast opt-out", async () => {
  const { client, toasts } = setup();
  const refusal = new ApiError(403, "workspace_cap", "Cap hit.");
  await runFailingMutation(client, refusal, { onError: () => undefined });
  await runFailingMutation(client, refusal, { meta: { errorToast: false } });
  assert.equal(toasts.length, 0);
});

test("defaults equal the constants, and the constants are 5 minutes and 1 hour", () => {
  assert.equal(QUERY_STALE_TIME_MS, 300_000);
  assert.equal(QUERY_GC_TIME_MS, 3_600_000);
  const { client } = setup();
  const defaults = client.getDefaultOptions();
  assert.equal(defaults.queries?.staleTime, QUERY_STALE_TIME_MS);
  assert.equal(defaults.queries?.gcTime, QUERY_GC_TIME_MS);
  assert.equal(defaults.queries?.retry, shouldRetryQuery);
  assert.equal(defaults.mutations?.retry, 0);
  // TanStack's default is kept (OpenSEO parity).
  assert.equal(defaults.queries?.refetchOnWindowFocus, undefined);
});

test("shouldRetryQuery: never on 4xx, otherwise at most twice", () => {
  assert.equal(shouldRetryQuery(0, new ApiError(404, "http_404", "x")), false);
  assert.equal(shouldRetryQuery(0, new ApiError(400, "http_400", "x")), false);
  assert.equal(shouldRetryQuery(0, new ApiError(499, "http_499", "x")), false);
  assert.equal(shouldRetryQuery(1, new ApiError(500, "http_500", "x")), true);
  assert.equal(shouldRetryQuery(2, new ApiError(500, "http_500", "x")), false);
  assert.equal(shouldRetryQuery(0, new ApiError(500, "http_500", "x")), true);
  assert.equal(shouldRetryQuery(0, new ApiError(0, "network_error", "x")), true);
  assert.equal(shouldRetryQuery(1, new Error("plain")), true);
  assert.equal(shouldRetryQuery(2, new Error("plain")), false);
});

test("a failing query retries at most twice (three attempts) and never on 4xx", async () => {
  const { client } = setup();
  let attempts = 0;
  const retryDelay = 0;
  await client
    .fetchQuery({
      queryKey: ["t", "5xx"],
      queryFn: () => {
        attempts += 1;
        return Promise.reject(new ApiError(500, "http_500", "x"));
      },
      retryDelay,
    })
    .catch(() => undefined);
  assert.equal(attempts, 3);

  attempts = 0;
  await client
    .fetchQuery({
      queryKey: ["t", "4xx"],
      queryFn: () => {
        attempts += 1;
        return Promise.reject(new ApiError(404, "http_404", "x"));
      },
      retryDelay,
    })
    .catch(() => undefined);
  assert.equal(attempts, 1);
});

test("a failing mutation is attempted exactly once", async () => {
  const { client } = setup();
  let attempts = 0;
  await client
    .getMutationCache()
    .build(client, {
      mutationFn: () => {
        attempts += 1;
        return Promise.reject(new ApiError(500, "http_500", "x"));
      },
    })
    .execute(undefined)
    .catch(() => undefined);
  assert.equal(attempts, 1);
});
