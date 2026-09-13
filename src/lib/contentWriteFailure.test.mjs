import test from "node:test";
import assert from "node:assert/strict";

import { insertContentEvent, getContentEvents } from "./db.js";
import { acquireLease, renewLease, releaseLease } from "./jobLease.js";
import { startContentJob } from "./content/contentWorker.js";
import {
  insertContentItem,
  insertContentFeedback,
  upsertBrandBrief,
  getBrandBrief,
  insertLessons,
  setLessonActive,
  insertAgent,
  updateAgent,
  deleteAgent,
} from "./db/content.js";
import {
  insertKnowledgeBlock,
  updateKnowledgeBlock,
  deleteKnowledgeBlock,
} from "./db/knowledge.js";

/**
 * Helpers to build mock Supabase clients with deterministic responses.
 */
function makeFailingClient(errorMsg = "Database connection error") {
  const err = new Error(errorMsg);
  const chain = {
    insert: () => chain,
    update: () => chain,
    upsert: () => chain,
    delete: () => chain,
    select: () => chain,
    eq: () => chain,
    or: () => chain,
    ilike: () => chain,
    order: () => chain,
    limit: () => chain,
    then(resolve) {
      resolve({ data: null, error: err });
    },
  };
  return {
    from: () => chain,
  };
}

function makeSuccessfulClient({ selectData = [], insertData = [], updateData = [], deleteData = [] } = {}) {
  return {
    from: (table) => {
      let op = "select";
      const chain = {
        insert: (rows) => {
          op = "insert";
          return chain;
        },
        update: (patch) => {
          op = "update";
          return chain;
        },
        delete: () => {
          op = "delete";
          return chain;
        },
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        ilike: () => chain,
        order: () => chain,
        limit: () => chain,
        then(resolve) {
          if (op === "insert") resolve({ data: insertData, error: null });
          else if (op === "update") resolve({ data: updateData, error: null });
          else if (op === "delete") resolve({ data: deleteData, error: null });
          else resolve({ data: selectData, error: null });
        },
      };
      return chain;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. insertContentEvent & getContentEvents (src/lib/db.js)
// ---------------------------------------------------------------------------

test("R2.8.8: insertContentEvent accepts injectable deps and writes to memory with client: null", async () => {
  const memory = new Map();
  const event = await insertContentEvent(
    { brand: "TestBrand", url: "https://testbrand.com/post", publishDate: "2026-09-12T00:00:00Z" },
    { client: null, memory }
  );
  assert.ok(event.id, "event has generated UUID");
  assert.equal(event.brand, "TestBrand");
  assert.equal(memory.size, 1);
  assert.equal(memory.get(event.id).url, "https://testbrand.com/post");
});

test("R2.8.8: insertContentEvent THROWS loudly when client returns error; does NOT fall back to memory", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("Postgres write error: connection timeout");

  await assert.rejects(
    () =>
      insertContentEvent(
        { brand: "TestBrand", url: "https://testbrand.com/post" },
        { client: failingClient, memory }
      ),
    /connection timeout/
  );

  assert.equal(memory.size, 0, "must NOT swallow the write failure into memory");
});

test("R2.8.8: insertContentEvent THROWS loudly when liveDbGate REFUSES the write", async () => {
  const memory = new Map();
  const refusalClient = makeFailingClient("LIVE WRITE GUARD REFUSED: production write to content_events");

  await assert.rejects(
    () =>
      insertContentEvent(
        { brand: "TestBrand", url: "https://testbrand.com/post" },
        { client: refusalClient, memory }
      ),
    /LIVE WRITE GUARD REFUSED/
  );

  assert.equal(memory.size, 0, "refused write must never masquerade as success in memory");
});

test("R2.8.8: getContentEvents accepts injectable deps and reads from memory with client: null", async () => {
  const memory = new Map();
  memory.set("1", { id: "1", brand: "Acme", url: "https://acme.com/a" });
  memory.set("2", { id: "2", brand: "Other", url: "https://other.com/b" });

  const events = await getContentEvents("Acme", { client: null, memory });
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "1");
});

test("R2.8.8: getContentEvents THROWS loudly on DB error; does NOT fall back to memory", async () => {
  const memory = new Map();
  memory.set("1", { id: "1", brand: "Acme", url: "https://acme.com/a" });
  const failingClient = makeFailingClient("Database read timeout");

  await assert.rejects(
    () => getContentEvents("Acme", { client: failingClient, memory }),
    /Database read timeout/
  );
});

// ---------------------------------------------------------------------------
// 2. Job lease functions (src/lib/jobLease.js)
// ---------------------------------------------------------------------------

test("R2.8.8: acquireLease accepts injectable client and throws on DB failure (fail-loud)", async () => {
  const failingClient = makeFailingClient("lease acquisition failed: deadlock");
  await assert.rejects(
    () => acquireLease("content_jobs", "job-123", "worker-1", { client: failingClient }),
    /deadlock/
  );
});

test("R2.8.8: renewLease accepts injectable client and throws on DB failure", async () => {
  const failingClient = makeFailingClient("lease renew failed: network error");
  await assert.rejects(
    () => renewLease("content_jobs", "job-123", "worker-1", { client: failingClient }),
    /network error/
  );
});

test("R2.8.8: releaseLease accepts injectable client and throws on DB failure", async () => {
  const failingClient = makeFailingClient("lease release failed: socket closed");
  await assert.rejects(
    () => releaseLease("content_jobs", "job-123", "worker-1", { client: failingClient }),
    /socket closed/
  );
});

// ---------------------------------------------------------------------------
// 3. contentWorker threading and fail-closed behavior (src/lib/content/contentWorker.js)
// ---------------------------------------------------------------------------

test("R2.8.8: startContentJob threads deps to acquireLease and fails closed on DB error", async () => {
  const failingClient = makeFailingClient("Supabase unavailable");
  let leaseAcquired = false;

  const result = await startContentJob("job-abc", {
    client: failingClient,
    acquireLease: async (table, jobId, owner, deps) => {
      assert.equal(table, "content_jobs");
      assert.equal(jobId, "job-abc");
      assert.ok(deps.client, "deps.client was threaded to acquireLease");
      leaseAcquired = true;
      throw new Error("Simulated lease acquisition outage");
    },
  });

  assert.ok(leaseAcquired, "injected acquireLease was called with deps");
  assert.equal(result, null, "worker fails closed (returns null) when lease acquisition fails");
});

test("R2.8.8: startContentJob threads deps to renewLease and releaseLease", async () => {
  const leaseCalls = [];
  const fakeJob = {
    id: "job-lease-test",
    brand: "Acme",
    playbook: "geo_article",
    status: "pending",
    cost_total: 0,
    agent_snapshot: { name: "Test Agent", format: "article", pipeline: ["draft", "review"] },
    created_at: new Date().toISOString(),
  };

  const result = await startContentJob("job-lease-test", {
    job: fakeJob,
    acquireLease: async (table, jobId, owner, deps) => {
      leaseCalls.push({ action: "acquire", table, jobId, owner, hasDeps: !!deps });
      return { id: jobId, lease_owner: owner };
    },
    renewLease: async (table, jobId, owner, deps) => {
      leaseCalls.push({ action: "renew", table, jobId, owner, hasDeps: !!deps });
      return { id: jobId, lease_owner: owner };
    },
    releaseLease: async (table, jobId, owner, deps) => {
      leaseCalls.push({ action: "release", table, jobId, owner, hasDeps: !!deps });
      return true;
    },
    updateContentJob: async (id, fields, deps) => fakeJob,
    resolveBrief: async () => ({ one_liner: "brief" }),
    listLessons: async () => [],
    getScansForBrand: async () => [],
    listKnowledgeBlocks: async () => [],
    callLlm: async () => ({}),
    llmJson: async () => ({}),
    runDraft: async () => ({ title: "Draft", body_md: "Body" }),
    runReview: async () => ({ verdict: "pass", weighted_total: 90 }),
    insertContentItem: async (item, deps) => ({ id: "item-1", ...item }),
  });

  assert.ok(leaseCalls.some((c) => c.action === "acquire" && c.hasDeps));
  assert.ok(leaseCalls.some((c) => c.action === "release" && c.hasDeps));
});

// ---------------------------------------------------------------------------
// 4. Content write helpers (src/lib/db/content.js) fail-loud assertions
// ---------------------------------------------------------------------------

test("R2.8.8: insertContentItem accepts deps and rejects on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("insertContentItem DB failure");

  await assert.rejects(
    () =>
      insertContentItem(
        { brand: "Acme", playbook: "geo_article" },
        { client: failingClient, memory }
      ),
    /insertContentItem DB failure/
  );
  assert.equal(memory.size, 0, "does not swallow to memory");
});

test("R2.8.8: insertContentFeedback accepts deps and rejects on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("insertContentFeedback DB failure");

  await assert.rejects(
    () =>
      insertContentFeedback(
        { item_id: "i1", brand: "Acme", playbook: "geo_article", verdict: "approved" },
        { client: failingClient, memory }
      ),
    /insertContentFeedback DB failure/
  );
  assert.equal(memory.size, 0, "does not swallow to memory");
});

test("R2.8.8: upsertBrandBrief accepts deps and rejects on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("upsertBrandBrief DB failure");

  await assert.rejects(
    () =>
      upsertBrandBrief(
        "Acme",
        { one_liner: "test brief" },
        { client: failingClient, memory }
      ),
    /upsertBrandBrief DB failure/
  );
  assert.equal(memory.size, 0, "does not swallow to memory");
});

test("R2.8.8: insertLessons accepts deps and rejects on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("insertLessons DB failure");

  await assert.rejects(
    () =>
      insertLessons(
        "Acme",
        "geo_article",
        ["Lesson 1", "Lesson 2"],
        null,
        { client: failingClient, memory }
      ),
    /insertLessons DB failure/
  );
  assert.equal(memory.size, 0, "does not swallow to memory");
});

test("R2.8.8: setLessonActive accepts deps and rejects on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("setLessonActive DB failure");

  await assert.rejects(
    () => setLessonActive("lesson-1", false, { client: failingClient, memory }),
    /setLessonActive DB failure/
  );
});

test("R2.8.8: insertAgent and updateAgent accept deps and reject on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("agent DB failure");

  await assert.rejects(
    () => insertAgent("Acme", { name: "Specialist" }, { client: failingClient, memory }),
    /agent DB failure/
  );
  assert.equal(memory.size, 0, "does not swallow to memory");

  await assert.rejects(
    () => updateAgent("agent-1", { name: "Specialist 2" }, { client: failingClient, memory }),
    /agent DB failure/
  );
});

test("R2.8.8: deleteAgent accepts deps and rejects on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("deleteAgent outage");

  await assert.rejects(
    () => deleteAgent("agent-1", { client: failingClient, memory }),
    /deleteAgent outage/
  );
});

test("R2.8.8: deleteAgent returns false for non-existent row and true for deleted row (no fabricated success)", async () => {
  // PostgREST returns empty array [] when no row matched the delete filter
  const clientNoRow = makeSuccessfulClient({ deleteData: [] });
  const deletedNone = await deleteAgent("non-existent-agent", { client: clientNoRow });
  assert.equal(deletedNone, false, "deleting non-existent ID must return false, NOT true");

  // PostgREST returns [{ id }] when row was deleted
  const clientDeleted = makeSuccessfulClient({ deleteData: [{ id: "agent-1" }] });
  const deletedReal = await deleteAgent("agent-1", { client: clientDeleted });
  assert.equal(deletedReal, true, "deleting existing ID must return true");
});

// ---------------------------------------------------------------------------
// 5. Knowledge write helpers (src/lib/db/knowledge.js) fail-loud assertions
// ---------------------------------------------------------------------------

test("R2.8.8: insertKnowledgeBlock accepts deps and rejects on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("insertKnowledgeBlock DB failure");

  await assert.rejects(
    () =>
      insertKnowledgeBlock(
        "Acme",
        { title: "Block 1", content: "Content" },
        { client: failingClient, memory }
      ),
    /insertKnowledgeBlock DB failure/
  );
  assert.equal(memory.size, 0, "does not swallow to memory");
});

test("R2.8.8: updateKnowledgeBlock accepts deps and rejects on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("updateKnowledgeBlock DB failure");

  await assert.rejects(
    () =>
      updateKnowledgeBlock(
        "k-1",
        { title: "Updated" },
        { client: failingClient, memory }
      ),
    /updateKnowledgeBlock DB failure/
  );
});

test("R2.8.8: deleteKnowledgeBlock accepts deps and rejects on DB failure", async () => {
  const memory = new Map();
  const failingClient = makeFailingClient("deleteKnowledgeBlock DB failure");

  await assert.rejects(
    () => deleteKnowledgeBlock("k-1", { client: failingClient, memory }),
    /deleteKnowledgeBlock DB failure/
  );
});

test("R2.8.8: deleteKnowledgeBlock returns false for non-existent row and true for deleted row (no fabricated success)", async () => {
  const clientNoRow = makeSuccessfulClient({ deleteData: [] });
  const deletedNone = await deleteKnowledgeBlock("non-existent-block", { client: clientNoRow });
  assert.equal(deletedNone, false, "deleting non-existent block must return false, NOT true");

  const clientDeleted = makeSuccessfulClient({ deleteData: [{ id: "k-1" }] });
  const deletedReal = await deleteKnowledgeBlock("k-1", { client: clientDeleted });
  assert.equal(deletedReal, true, "deleting existing block must return true");
});
