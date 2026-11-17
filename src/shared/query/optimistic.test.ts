// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/useSetKeywordPinned.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createQueryClient } from "./queryClient.ts";
import { optimisticHandlers } from "./optimistic.ts";

const created: Array<ReturnType<typeof createQueryClient>> = [];
after(() => {
  for (const client of created) client.clear();
});

function setup() {
  const toasts: Array<{ title: string; description?: string }> = [];
  const client = createQueryClient({
    toastError: (title, description) => toasts.push({ title, description }),
  });
  created.push(client);
  return { client, toasts };
}

test("optimisticHandlers: patches matching queries on mutate", async () => {
  const { client } = setup();

  client.setQueryData(["rows", "a", 1], { count: 10 });
  client.setQueryData(["rows", "a", 2], { count: 20 });
  client.setQueryData(["rows", "b", 1], { count: 30 });

  const handlers = optimisticHandlers<{ delta: number }, { count: number }>(
    client,
    ["rows", "a"],
    (old, vars) => ({ count: old.count + vars.delta })
  );

  await handlers.onMutate({ delta: 5 });

  assert.deepEqual(client.getQueryData(["rows", "a", 1]), { count: 15 });
  assert.deepEqual(client.getQueryData(["rows", "a", 2]), { count: 25 });
  // Unrelated key untouched
  assert.deepEqual(client.getQueryData(["rows", "b", 1]), { count: 30 });
});

test("optimisticHandlers: onSettled invalidates on error, but not on success", async () => {
  const { client } = setup();

  client.setQueryData(["rows", "a", 1], { count: 10 });
  client.setQueryData(["rows", "a", 2], { count: 20 });

  const handlers = optimisticHandlers<{ delta: number }, { count: number }>(
    client,
    ["rows", "a"],
    (old, vars) => ({ count: old.count + vars.delta })
  );

  // Success case: no error
  handlers.onSettled({ ok: true }, null);
  const q1 = client.getQueryCache().find({ queryKey: ["rows", "a", 1] });
  const q2 = client.getQueryCache().find({ queryKey: ["rows", "a", 2] });
  assert.equal(q1?.state.isInvalidated, false);
  assert.equal(q2?.state.isInvalidated, false);

  // Error case: invalidates matching queries
  handlers.onSettled(undefined, new Error("mutation failed"));
  assert.equal(q1?.state.isInvalidated, true);
  assert.equal(q2?.state.isInvalidated, true);
});

test("optimisticHandlers: mutation with handlers and no onError still triggers client error toast", async () => {
  const { client, toasts } = setup();

  const handlers = optimisticHandlers<{ delta: number }, { count: number }>(
    client,
    ["rows", "a"],
    (old, vars) => ({ count: old.count + vars.delta })
  );

  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => {
      throw new Error("server rejected");
    },
    ...handlers,
  });

  await mutation.execute({ delta: 5 }).catch(() => {});

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, "server rejected");
});
