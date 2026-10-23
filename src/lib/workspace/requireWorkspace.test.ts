import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireWorkspace } from "./requireWorkspace.ts";
import type { CustomerBrand, CustomerContext } from "./requireWorkspace.ts";
import { WorkspaceError } from "../http/errors.ts";

const ADMIN = {} as unknown as SupabaseClient;

const ACME: CustomerBrand = {
  brandKey: "acme",
  role: "owner",
  display_name: "Acme",
  website: "https://acme.test",
  website_host: "acme.test",
  aliases: [],
  is_active: true,
};

const BETA: CustomerBrand = {
  ...ACME,
  brandKey: "beta",
  role: "member",
  display_name: "Beta",
  website: "https://beta.test",
  website_host: "beta.test",
};

function context(overrides: Partial<CustomerContext> = {}): CustomerContext {
  return {
    client: null,
    user: { id: "user-1", email: "owner@acme.test" },
    brands: [ACME, BETA],
    error: null,
    ...overrides,
  };
}

function deps(overrides: Partial<CustomerContext> = {}, admin: SupabaseClient | null = ADMIN) {
  return {
    getCustomerContext: async () => context(overrides),
    getSupabaseAdmin: () => admin,
  };
}

function request(url = "https://app.test/api/customer/test", init?: RequestInit): Request {
  return new Request(url, init);
}

async function rejection(promise: Promise<unknown>): Promise<WorkspaceError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WorkspaceError, "expected a WorkspaceError");
    return err;
  }
  throw new Error("expected a rejection");
}

test("missing auth configuration is 503 auth_not_configured", async () => {
  const err = await rejection(
    requireWorkspace(request(), {}, deps({ error: "auth_not_configured", user: null, brands: [] }))
  );
  assert.equal(err.status, 503);
  assert.equal(err.code, "auth_not_configured");
  assert.equal(err.message, "Customer login is not configured.");
});

test("no signed-in user is 401 unauthenticated", async () => {
  const err = await rejection(requireWorkspace(request(), {}, deps({ user: null })));
  assert.equal(err.status, 401);
  assert.equal(err.code, "unauthenticated");
  assert.equal(err.message, "Please sign in.");
});

test("a membership read failure is 503 membership_unavailable", async () => {
  const err = await rejection(
    requireWorkspace(request(), {}, deps({ error: "membership_unavailable", brands: [] }))
  );
  assert.equal(err.status, 503);
  assert.equal(err.code, "membership_unavailable");
  assert.equal(err.message, "Could not load workspace access.");
});

test("a cross-site write is 403 cross_site", async () => {
  const foreignOrigin = await rejection(
    requireWorkspace(
      request("https://app.test/api/customer/test", {
        method: "POST",
        headers: { origin: "https://evil.test" },
      }),
      {},
      deps()
    )
  );
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.code, "cross_site");
  assert.equal(foreignOrigin.message, "Cross-site requests are not allowed.");

  const crossSite = await rejection(
    requireWorkspace(
      request("https://app.test/api/customer/test", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      {},
      deps()
    )
  );
  assert.equal(crossSite.code, "cross_site");
});

test("an unknown brand is 404 workspace_not_found", async () => {
  const err = await rejection(
    requireWorkspace(request("https://app.test/api/customer/test?brand_key=other"), {}, deps())
  );
  assert.equal(err.status, 404);
  assert.equal(err.code, "workspace_not_found");
  assert.equal(err.message, "Workspace not found.");
});

test("an empty brand key falls back to the first membership", async () => {
  const emptyOpt = await requireWorkspace(
    request("https://app.test/api/customer/test"),
    { brandKey: "" },
    deps()
  );
  assert.equal(emptyOpt.brandKey, "acme");

  const emptyQuery = await requireWorkspace(
    request("https://app.test/api/customer/test?brand_key="),
    {},
    deps()
  );
  assert.equal(emptyQuery.brandKey, "acme");
});

test("a member on an owner-only route is 403 owner_required", async () => {
  const err = await rejection(
    requireWorkspace(
      request("https://app.test/api/customer/test?brand_key=beta"),
      { role: "owner" },
      deps()
    )
  );
  assert.equal(err.status, 403);
  assert.equal(err.code, "owner_required");
  assert.equal(err.message, "Only the workspace owner can do this.");
});

test("a role that is not exactly owner is refused on an owner-only route", async () => {
  const viewer = { ...BETA, role: "viewer" } as unknown as CustomerBrand;
  const err = await rejection(
    requireWorkspace(
      request("https://app.test/api/customer/test"),
      { role: "owner" },
      deps({ brands: [viewer] })
    )
  );
  assert.equal(err.status, 403);
  assert.equal(err.code, "owner_required");
});

test("a missing service client is 503 storage_unavailable", async () => {
  const err = await rejection(requireWorkspace(request(), {}, deps({}, null)));
  assert.equal(err.status, 503);
  assert.equal(err.code, "storage_unavailable");
  assert.equal(err.message, "Workspace storage is unavailable.");
});

test("the brand key comes from opts, then the query string, then the first membership", async () => {
  const fromOpts = await requireWorkspace(
    request("https://app.test/api/customer/test?brand_key=beta"),
    { brandKey: "acme" },
    deps()
  );
  assert.equal(fromOpts.brandKey, "acme");

  const fromQuery = await requireWorkspace(
    request("https://app.test/api/customer/test?brand_key=beta"),
    {},
    deps()
  );
  assert.equal(fromQuery.brandKey, "beta");

  const fromMembership = await requireWorkspace(request(), {}, deps());
  assert.equal(fromMembership.brandKey, "acme");
});

test("a successful call returns the user, brand, role and admin client", async () => {
  const workspace = await requireWorkspace(request(), {}, deps());
  assert.deepEqual(workspace.user, { id: "user-1", email: "owner@acme.test" });
  assert.equal(workspace.brandKey, "acme");
  assert.deepEqual(workspace.brand, ACME);
  assert.equal(workspace.role, "owner");
  assert.equal(workspace.admin, ADMIN);
});
