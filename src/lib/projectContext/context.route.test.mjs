/**
 * F07 §6.5 — `/api/customer/context` GET and PATCH, exercised through the real
 * route handlers and the real service. Only the authenticated request context
 * and the storage transport are substituted, so these cases are evidence about
 * the handlers and not about a mock.
 *
 * Two seams, as the sibling customer-route tests established:
 *   1. `src/lib/customerRoutes.test.hooks.mjs`, registered below, which answers
 *      the `@/lib/supabase/*` specifiers with `globalThis.customerRouteFixture`;
 *   2. the route's own `deps` argument, mirroring `src/app/api/customer/privacy/route.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const ROUTE = await import(new URL("../../app/api/customer/context/route.ts", import.meta.url).href);
const { createMemoryProjectContextRepository } = await import("./memoryRepository.ts");
const { createProjectContextRepository } = await import("./repository.ts");
const { applyContextUpdates, getProjectContext } = await import("./service.ts");
const { updateProjectContextBody } = await import("../../shared/project-context.ts");

const USER = { id: "user-1", email: "owner@example.test" };
const BRAND_KEY = "offcult.in";
const fixedNow = () => new Date("2026-10-25T00:30:00.000Z");

function brand(role = "member") {
  return {
    brandKey: BRAND_KEY,
    role,
    display_name: "Offcult",
    website: "https://offcult.in",
    website_host: "www.offcult.in",
    aliases: ["Offcult", "offcult"],
    is_active: true,
  };
}

function memoryRepo(role = "member") {
  return createMemoryProjectContextRepository({
    now: fixedNow,
    brandBriefs: { [BRAND_KEY]: { one_liner: "Oversized anime tees, India" } },
  });
}

/** Everything the route needs, with the real service bound to an in-memory repository. */
function deps(over = {}) {
  const role = over.role ?? "member";
  const repo = over.repo ?? memoryRepo(role);
  const calls = { imported: 0, applied: 0 };
  const base = {
    getCustomerContext: async () => ({ client: null, user: USER, brands: [brand(role)], error: null }),
    getSupabaseAdmin: () => ({}),
    isFeatureEnabled: async () => true,
    maybeImportBrandBrief: async () => {
      calls.imported += 1;
      return false;
    },
    getProjectContext: (admin, b) => getProjectContext(admin, b, { repo, now: fixedNow }),
    applyContextUpdates: (admin, b, updates, author, actor) => {
      calls.applied += 1;
      return applyContextUpdates(admin, b, updates, author, actor, { repo, now: fixedNow });
    },
    ...over,
  };
  return { deps: base, repo, calls };
}

async function read(response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    contentType: response.headers.get("content-type"),
    body: await response.json(),
  };
}

function getRequest() {
  return new Request(`https://app.test/api/customer/context?brand_key=${BRAND_KEY}`);
}

function patchRequest(body) {
  return new Request(`https://app.test/api/customer/context?brand_key=${BRAND_KEY}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seed(repo) {
  repo.sections.set(`${BRAND_KEY}\0business_overview`, {
    brandKey: BRAND_KEY,
    key: "business_overview",
    title: null,
    content: "Oversized anime tees, India",
    updatedAt: "2026-10-21T09:12:00.000Z",
    updatedBy: "user",
    updatedByUser: USER.id,
  });
  repo.sections.set(`${BRAND_KEY}\0custom:priority-topics`, {
    brandKey: BRAND_KEY,
    key: "custom:priority-topics",
    title: "Priority topics",
    content: "- Anime streetwear",
    updatedAt: "2026-10-21T09:12:00.000Z",
    updatedBy: "system",
    updatedByUser: null,
  });
  repo.competitors.set(`${BRAND_KEY}\0bewakoof.com`, {
    brandKey: BRAND_KEY,
    id: "competitor-1",
    domain: "bewakoof.com",
    name: "Bewakoof",
    notes: null,
    source: "setup_research",
    sourceUrl: "https://bewakoof.com/men-oversized-t-shirts",
    updatedAt: "2026-10-21T09:12:00.000Z",
    updatedBy: "user",
    updatedByUser: USER.id,
  });
  repo.keyPages.set(`${BRAND_KEY}\0https://offcult.in/collections/oversized-tees`, {
    brandKey: BRAND_KEY,
    id: "page-1",
    url: "https://offcult.in/collections/oversized-tees",
    role: "money",
    topic: "oversized t-shirts",
    notes: null,
    updatedAt: "2026-10-21T09:12:00.000Z",
    updatedBy: "user",
    updatedByUser: USER.id,
  });
  repo.researchLog.push({
    brandKey: BRAND_KEY,
    id: "research-1",
    entryDate: "2026-10-21",
    kind: "platform.selftest",
    researchKey: BRAND_KEY,
    summary: "Website research: overview, 5 competitors checked, 25 draft questions.",
    spendUsd: 0.0841,
    jobId: null,
    createdBy: "system",
    createdByUser: null,
    createdAt: "2026-10-21T09:12:00.000Z",
  });
}

test("GET returns the context in declared order, without caching", async () => {
  const { deps: injected, repo } = deps();
  seed(repo);

  const { status, cacheControl, contentType, body } = await read(await ROUTE.GET(getRequest(), {}, injected));

  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.equal(contentType, "application/json; charset=utf-8");
  assert.deepEqual(Object.keys(body), [
    "brandKey",
    "sections",
    "missingSections",
    "customSections",
    "competitors",
    "keyPages",
    "researchLog",
    "researchLogLimited",
    "brandIdentity",
  ]);
  assert.equal(body.brandKey, BRAND_KEY);
  assert.deepEqual(body.sections, [{
    key: "business_overview",
    content: "Oversized anime tees, India",
    updatedAt: "2026-10-21T09:12:00.000Z",
    updatedBy: "user",
    updatedByUser: USER.id,
  }]);
  assert.deepEqual(body.missingSections, ["current_goal", "positioning", "writing_preferences"]);
  assert.deepEqual(body.customSections.map((row) => row.slug), ["priority-topics"]);
  assert.deepEqual(body.competitors.map((row) => row.domain), ["bewakoof.com"]);
  assert.deepEqual(body.keyPages.map((row) => row.url), ["https://offcult.in/collections/oversized-tees"]);
  assert.deepEqual(body.researchLog.map((row) => row.id), ["research-1"]);
  assert.equal(body.researchLogLimited, false);
  assert.deepEqual(body.brandIdentity, {
    displayName: "Offcult",
    website: "https://offcult.in",
    matchNames: ["Offcult", "offcult"],
  });
});

test("GET triggers the lazy brief import; PATCH never does", async () => {
  const get = deps();
  await read(await ROUTE.GET(getRequest(), {}, get.deps));
  assert.equal(get.calls.imported, 1, "the read owns the import (GAP-10)");

  const patch = deps();
  await read(await ROUTE.PATCH(patchRequest({ updates: [{ section: "current_goal", content: "Ship by March" }] }), {}, patch.deps));
  assert.equal(patch.calls.imported, 0, "a write never imports a brief");
  assert.equal(patch.calls.applied, 1);
});

test("PATCH stores author \"user\" with the caller id and returns the new context", async () => {
  const { deps: injected, repo } = deps();

  const { status, cacheControl, body } = await read(
    await ROUTE.PATCH(
      patchRequest({
        updates: [
          { section: "current_goal", content: "  Be named for 'oversized tees India' by March.  " },
          { addCompetitors: [{ domain: "https://www.thesouledstore.com/", name: "The Souled Store" }] },
          { addKeyPages: [{ url: "offcult.in/collections/oversized-tees", role: "money", topic: "oversized t-shirts" }] },
        ],
      }),
      {},
      injected,
    ),
  );

  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");

  const written = repo.sections.get(`${BRAND_KEY}\0current_goal`);
  assert.equal(written?.updatedBy, "user");
  assert.equal(written?.updatedByUser, USER.id);
  assert.equal(written?.content, "Be named for 'oversized tees India' by March.");
  assert.equal(repo.competitors.get(`${BRAND_KEY}\0thesouledstore.com`)?.source, "manual");
  assert.equal(repo.competitors.get(`${BRAND_KEY}\0thesouledstore.com`)?.updatedByUser, USER.id);
  assert.deepEqual(body.sections.map((row) => row.key), ["current_goal"]);
});

test("the §6.5 PATCH example body is accepted as written", async () => {
  const { deps: injected } = deps();
  const body = {
    updates: [
      { section: "current_goal", content: "Be named for 'oversized tees India' by March." },
      { addCompetitors: [{ domain: "https://www.thesouledstore.com/", name: "The Souled Store" }] },
      { addKeyPages: [{ url: "offcult.in/collections/oversized-tees", role: "money", topic: "oversized t-shirts" }] },
    ],
  };
  assert.equal(updateProjectContextBody.safeParse(body).success, true, "the documented body must parse");
  const { status } = await read(await ROUTE.PATCH(patchRequest(body), {}, injected));
  assert.equal(status, 200);
});

test("a rejected update answers context_invalid with details.index", async () => {
  const { deps: injected } = deps();
  const { status, body } = await read(
    await ROUTE.PATCH(
      patchRequest({
        updates: [
          { section: "positioning", content: "Heavier fabric than fast fashion." },
          { section: "business_overview", content: "x".repeat(4_001) },
        ],
      }),
      {},
      injected,
    ),
  );

  assert.equal(status, 400);
  assert.equal(body.code, "context_invalid");
  assert.deepEqual(body.details, { index: 1 });
  assert.match(body.error, /^updates\[1\] was rejected \(nothing in this batch was applied\): /);
});

test("a cap enforced by the database answers context_cap", async () => {
  // The resolver pre-checks the caps, so the wire's `context_cap` comes from the
  // SQL function's own re-check, mapped by the repository. This admin returns
  // that function's error verbatim, so the mapping is the real one.
  const capAdmin = { rpc: async () => ({ data: null, error: { message: "project_memory_cap:key_pages" } }) };
  const memory = memoryRepo();
  const capRepo = {
    ...memory,
    applyOps: (brandKey, ops, author, actor) =>
      createProjectContextRepository(capAdmin).applyOps(brandKey, ops, author, actor),
  };
  const { deps: injected } = deps({ repo: capRepo });

  const { status, body } = await read(
    await ROUTE.PATCH(
      patchRequest({ updates: [{ addKeyPages: [{ url: "offcult.in/collections/anime-drop", role: "money" }] }] }),
      {},
      injected,
    ),
  );

  assert.equal(status, 400);
  assert.equal(body.code, "context_cap");
  assert.equal(body.error, "A workspace can hold 100 key pages. This is a shortlist, not a page inventory.");
});

test("a cap the resolver itself refuses names the rejected update as context_invalid", async () => {
  const { deps: injected, repo } = deps();
  seed(repo);
  const { status, body } = await read(
    await ROUTE.PATCH(
      patchRequest({
        updates: [{
          addCompetitors: Array.from({ length: 100 }, (_unused, index) => ({ domain: `competitor-${index}.example` })),
        }],
      }),
      {},
      injected,
    ),
  );

  assert.equal(status, 400);
  assert.equal(body.code, "context_invalid");
  assert.deepEqual(body.details, { index: 0 });
  assert.match(body.error, /A workspace can track 100 competitors\. Remove some first\.$/);
});

test("51 updates are refused by zod before any service call", async () => {
  let applied = 0;
  const { deps: injected } = deps({
    applyContextUpdates: async () => {
      applied += 1;
      return {};
    },
  });
  const { status, body } = await read(
    await ROUTE.PATCH(
      patchRequest({
        updates: Array.from({ length: 51 }, () => ({ section: "business_overview", content: "Tees" })),
      }),
      {},
      injected,
    ),
  );

  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
  assert.equal(applied, 0, "nothing reaches the resolver or the 1–60-operation RPC");
});

test("flag off answers 404 feature_unavailable and never touches memory", async () => {
  let touched = 0;
  const { deps: injected } = deps({
    isFeatureEnabled: async () => false,
    maybeImportBrandBrief: async () => {
      touched += 1;
      return false;
    },
    getProjectContext: async () => {
      touched += 1;
      return {};
    },
    applyContextUpdates: async () => {
      touched += 1;
      return {};
    },
  });

  const get = await read(await ROUTE.GET(getRequest(), {}, injected));
  assert.equal(get.status, 404);
  assert.equal(get.body.code, "feature_unavailable");
  assert.equal(get.body.error, "This page is not available for your workspace yet.");

  const patch = await read(
    await ROUTE.PATCH(patchRequest({ updates: [{ section: "current_goal", content: "Ship by March" }] }), {}, injected),
  );
  assert.equal(patch.status, 404);
  assert.equal(patch.body.code, "feature_unavailable");
  assert.equal(touched, 0, "the flag is checked before any read or write");
});

test("a member may read and edit memory", async () => {
  const { deps: injected, repo } = deps({ role: "member" });

  const read200 = await read(await ROUTE.GET(getRequest(), {}, injected));
  assert.equal(read200.status, 200);

  const patch200 = await read(
    await ROUTE.PATCH(patchRequest({ updates: [{ section: "positioning", content: "Heavier fabric" }] }), {}, injected),
  );
  assert.equal(patch200.status, 200);
  assert.equal(repo.sections.get(`${BRAND_KEY}\0positioning`)?.updatedBy, "user");
});

test("a cross-site PATCH is refused by requireWorkspace with 403 cross_site", async () => {
  const { deps: injected, calls } = deps();
  const request = new Request(`https://app.test/api/customer/context?brand_key=${BRAND_KEY}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ updates: [{ section: "current_goal", content: "Ship by March" }] }),
  });

  const { status, body } = await read(await ROUTE.PATCH(request, {}, injected));
  assert.equal(status, 403);
  assert.equal(body.code, "cross_site");
  assert.equal(calls.applied, 0);
});

test("an unauthenticated read answers 401", async () => {
  const { deps: injected } = deps({
    getCustomerContext: async () => ({ client: null, user: null, brands: [], error: null }),
  });
  const { status, body } = await read(await ROUTE.GET(getRequest(), {}, injected));
  assert.equal(status, 401);
  assert.equal(body.code, "unauthenticated");
});

test("an unknown query parameter is a closed-schema refusal", async () => {
  const { deps: injected } = deps();
  const request = new Request(`https://app.test/api/customer/context?brand_key=${BRAND_KEY}&unexpected=1`);
  const { status, body } = await read(await ROUTE.GET(request, {}, injected));
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
});
