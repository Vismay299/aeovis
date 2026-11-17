import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "../../app/api/customer/audit/crawler-access/route.ts";
import { DELETE } from "../../app/api/customer/audit/crawler-access/[id]/route.ts";

const workspace = {
  user: { id: "user-a", email: "owner@example.test" },
  brandKey: "brand-a",
  brand: { website_host: "example.com", website: "https://example.com" },
  role: "owner",
  admin: null,
};

const credentialId = "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d";
const foreignId = "22222222-3333-4444-8555-666666666666";

const credential = {
  id: credentialId,
  host: "shop.example.com",
  provider: "shopify",
  createdAt: "2026-11-16T09:00:00.000Z",
  expiresAt: null,
};

const signatureInput = 'sig1=("@authority" "signature-agent");keyid="test-key"';
const signature = "sig1=:EXAMPLE-NOT-A-REAL-SIGNATURE:";

function request(path, init) {
  return new Request(`https://app.example${path}`, init);
}

function postRequest(body) {
  return request("/api/customer/audit/crawler-access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteRequest(id, query = "") {
  return request(`/api/customer/audit/crawler-access/${id}${query}`, { method: "DELETE" });
}

function deps(overrides = {}) {
  return {
    requireWorkspace: async () => ({ ...workspace }),
    isFeatureEnabled: async () => true,
    ...overrides,
  };
}

function throwingAdmin() {
  const admin = {
    touched: 0,
    from() {
      admin.touched += 1;
      throw new Error("the database must not be read");
    },
  };
  return admin;
}

test("crawler access GET returns the summaries with no-store", async () => {
  let seenBrandKey;
  const response = await GET(
    request("/api/customer/audit/crawler-access?brand_key=brand-a"),
    undefined,
    deps({
      requireWorkspace: async (_request, opts) => {
        seenBrandKey = opts.brandKey;
        return { ...workspace };
      },
      listCrawlerCredentials: async (_admin, brandKey) => {
        assert.equal(brandKey, "brand-a");
        return [credential];
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { credentials: [credential] });
  assert.equal(seenBrandKey, "brand-a");
});

test("crawler access POST saves and returns 201 with the credential summary", async () => {
  let saved = null;
  const response = await POST(
    postRequest({
      brand_key: "brand-a",
      host: "shop.example.com",
      signatureInput,
      signature,
    }),
    undefined,
    deps({
      saveCrawlerCredential: async (_admin, input) => {
        saved = input;
        return { credential };
      },
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { credential });
  assert.equal(saved.brandKey, "brand-a");
  assert.equal(saved.userId, "user-a");
  assert.equal(saved.host, "shop.example.com");
  assert.equal(saved.signatureInput, signatureInput);
  assert.equal(saved.signature, signature);
  assert.equal(saved.workspaceHost, "example.com");
});

test("crawler access POST returns the exact www-twin 422 without echoing the values", async () => {
  const response = await POST(
    postRequest({ host: "shop.example.com", signatureInput, signature }),
    undefined,
    deps({
      saveCrawlerCredential: async () => ({
        problem: {
          reason: "wrong_domain",
          host: "shop.example.com",
          signedHost: "www.shop.example.com",
        },
      }),
    }),
  );
  assert.equal(response.status, 422);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    error:
      "This signature was made for www.shop.example.com. Create one for shop.example.com in Shopify.",
    code: "signature_wrong_domain",
  });
  assert.ok(!body.includes(signatureInput));
  assert.ok(!body.includes(signature));
});

test("crawler access POST returns the exact invalid-signature and invalid-host 422 copy", async () => {
  const invalidSignature = await POST(
    postRequest({ host: "shop.example.com", signatureInput, signature }),
    undefined,
    deps({
      saveCrawlerCredential: async () => ({
        problem: { reason: "invalid", host: "shop.example.com" },
      }),
    }),
  );
  assert.equal(invalidSignature.status, 422);
  assert.deepEqual(await invalidSignature.json(), {
    error:
      "This doesn't look like a complete Shopify crawler signature. Copy both values again.",
    code: "signature_invalid",
  });

  const invalidHost = await POST(
    postRequest({ host: "h://5.6", signatureInput, signature }),
    undefined,
    deps({
      saveCrawlerCredential: async () => ({
        problem: { reason: "invalid_host", host: "h://5.6" },
      }),
    }),
  );
  assert.equal(invalidHost.status, 422);
  assert.deepEqual(await invalidHost.json(), {
    error: "Enter a store domain, for example shop.example.com.",
    code: "invalid_host",
  });
});

test("crawler access POST refuses an unowned host with the start-route copy", async () => {
  const response = await POST(
    postRequest({ host: "someone-else.test", signatureInput, signature }),
    undefined,
    deps({
      saveCrawlerCredential: async () => ({
        problem: {
          reason: "audit_host_not_owned",
          host: "someone-else.test",
          workspaceHost: "example.com",
        },
      }),
    }),
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "Site audits run on your workspace website (example.com) and its subdomains.",
    code: "audit_host_not_owned",
  });
});

test("crawler access is owner-only with the exact member copy", async () => {
  let called = 0;
  const memberDeps = deps({
    requireWorkspace: async () => ({ ...workspace, role: "member" }),
    listCrawlerCredentials: async () => {
      called += 1;
      return [];
    },
    saveCrawlerCredential: async () => {
      called += 1;
      return { credential };
    },
    deleteCrawlerCredential: async () => {
      called += 1;
      return true;
    },
  });

  for (const response of [
    await GET(request("/api/customer/audit/crawler-access"), undefined, memberDeps),
    await POST(
      postRequest({ host: "shop.example.com", signatureInput, signature }),
      undefined,
      memberDeps,
    ),
    await DELETE(deleteRequest(credentialId), { params: { id: credentialId } }, memberDeps),
  ]) {
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "Only the workspace owner can manage Shopify crawler access.",
      code: "owner_required",
    });
  }
  assert.equal(called, 0);
});

test("all crawler-access routes return 404 feature_unavailable when site_audit is off", async () => {
  const offDeps = deps({ isFeatureEnabled: async (name) => name !== "site_audit" });
  for (const response of [
    await GET(request("/api/customer/audit/crawler-access"), undefined, offDeps),
    await POST(
      postRequest({ host: "shop.example.com", signatureInput, signature }),
      undefined,
      offDeps,
    ),
    await DELETE(deleteRequest(credentialId), { params: { id: credentialId } }, offDeps),
  ]) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "This page is not available for your workspace yet.",
      code: "feature_unavailable",
    });
  }
});

test("all crawler-access routes return 403 feature_disabled when the sub-flag is off", async () => {
  const disabledDeps = deps({
    isFeatureEnabled: async (name) => name !== "site_audit_crawler_access",
  });
  for (const response of [
    await GET(request("/api/customer/audit/crawler-access"), undefined, disabledDeps),
    await POST(
      postRequest({ host: "shop.example.com", signatureInput, signature }),
      undefined,
      disabledDeps,
    ),
    await DELETE(deleteRequest(credentialId), { params: { id: credentialId } }, disabledDeps),
  ]) {
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "This feature is not enabled for your workspace.",
      code: "feature_disabled",
    });
  }
});

test("crawler access DELETE returns 200, and 404 for a foreign, missing or malformed id", async () => {
  const deleted = [];
  const okDeps = deps({
    deleteCrawlerCredential: async (_admin, brandKey, id) => {
      deleted.push({ brandKey, id });
      return id === credentialId;
    },
  });
  const ok = await DELETE(
    deleteRequest(credentialId, "?brand_key=brand-a"),
    { params: { id: credentialId } },
    okDeps,
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { deleted: true });
  assert.deepEqual(deleted, [{ brandKey: "brand-a", id: credentialId }]);

  const foreign = await DELETE(
    deleteRequest(foreignId, "?brand_key=brand-a"),
    { params: { id: foreignId } },
    okDeps,
  );
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), {
    error: "Crawler access not found.",
    code: "credential_not_found",
  });

  let deleteCalls = 0;
  const malformed = await DELETE(
    deleteRequest("not-a-uuid"),
    { params: { id: "not-a-uuid" } },
    deps({
      deleteCrawlerCredential: async () => {
        deleteCalls += 1;
        return true;
      },
    }),
  );
  assert.equal(malformed.status, 404);
  assert.equal((await malformed.json()).code, "credential_not_found");
  assert.equal(deleteCalls, 0);
});

test("a missing encryption key gives GET and POST 503 before any database read, DELETE still 200", async () => {
  const admin = throwingAdmin();
  const missingKeyDeps = deps({
    requireWorkspace: async () => ({ ...workspace, admin }),
    env: {},
  });

  const list = await GET(
    request("/api/customer/audit/crawler-access"),
    undefined,
    missingKeyDeps,
  );
  assert.equal(list.status, 503);
  assert.deepEqual(await list.json(), {
    error: "Shopify crawler access is unavailable right now. Please retry.",
    code: "crawler_access_unavailable",
  });

  const save = await POST(
    postRequest({ host: "shop.example.com", signatureInput, signature }),
    undefined,
    missingKeyDeps,
  );
  assert.equal(save.status, 503);
  assert.equal((await save.json()).code, "crawler_access_unavailable");
  assert.equal(admin.touched, 0, "the key check runs before any DB read");

  const remove = await DELETE(
    deleteRequest(credentialId),
    { params: { id: credentialId } },
    deps({
      requireWorkspace: async () => ({ ...workspace, admin }),
      env: {},
      deleteCrawlerCredential: async () => true,
    }),
  );
  assert.equal(remove.status, 200);
  assert.deepEqual(await remove.json(), { deleted: true });
});

test("a database failure returns the specified 503 audit_unavailable", async () => {
  const boom = async () => {
    throw new Error("database is down");
  };
  for (const response of [
    await GET(
      request("/api/customer/audit/crawler-access"),
      undefined,
      deps({ listCrawlerCredentials: boom }),
    ),
    await POST(
      postRequest({ host: "shop.example.com", signatureInput, signature }),
      undefined,
      deps({ saveCrawlerCredential: boom }),
    ),
    await DELETE(
      deleteRequest(credentialId),
      { params: { id: credentialId } },
      deps({ deleteCrawlerCredential: boom }),
    ),
  ]) {
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Site audits are unavailable right now. Please retry.",
      code: "audit_unavailable",
    });
  }
});

test("secrets: API responses carry no plaintext signature values or encrypted columns", async () => {
  const bodies = [];
  const depsFor = deps({
    listCrawlerCredentials: async () => [credential],
    saveCrawlerCredential: async () => ({ credential }),
    deleteCrawlerCredential: async () => true,
  });
  bodies.push(
    await (
      await GET(request("/api/customer/audit/crawler-access"), undefined, depsFor)
    ).text(),
  );
  bodies.push(
    await (
      await POST(
        postRequest({ host: "shop.example.com", signatureInput, signature }),
        undefined,
        depsFor,
      )
    ).text(),
  );
  bodies.push(
    await (
      await DELETE(deleteRequest(credentialId), { params: { id: credentialId } }, depsFor)
    ).text(),
  );

  for (const body of bodies) {
    assert.ok(!body.includes(signatureInput), "the Signature-Input value must never be returned");
    assert.ok(!body.includes(signature), "the Signature value must never be returned");
    assert.ok(!/encrypted_|key_version|signatureInput|"signature"/.test(body));
  }
});

test("secrets: error responses never echo the submitted signature values", async () => {
  for (const problem of [
    { reason: "invalid", host: "shop.example.com" },
    { reason: "wrong_domain", host: "shop.example.com", signedHost: "www.shop.example.com" },
    { reason: "invalid_host", host: "shop.example.com" },
  ]) {
    const response = await POST(
      postRequest({ host: "shop.example.com", signatureInput, signature }),
      undefined,
      deps({ saveCrawlerCredential: async () => ({ problem }) }),
    );
    const body = await response.text();
    assert.equal(response.status, 422);
    assert.ok(!body.includes(signatureInput));
    assert.ok(!body.includes(signature));
    assert.ok(!/encrypted_/i.test(body));
  }
});
