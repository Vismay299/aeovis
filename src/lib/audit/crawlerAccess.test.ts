// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/crawler-access.test.ts
//   src/server/features/audit/services/CrawlerCredentialService.test.ts
//   src/server/features/audit/services/AuditService.crawlerAccess.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHOPIFY_SIGNATURE_AGENT,
  crawlerHeadersFor,
  deleteCrawlerCredential,
  isCrawlerAccessExpired,
  listCrawlerCredentials,
  normalizeCrawlerHost,
  openCrawlerAccess,
  parseSignatureExpiry,
  resolveCrawlerAccess,
  saveCrawlerCredential,
  shopifyCrawlerHeaders,
  type SealedCrawlerAccess,
} from "./crawlerAccess.ts";
import {
  crawlerAccessAad,
  decryptCrawlerField,
  encryptCrawlerField,
  isCrawlerAccessConfigured,
} from "./crawlerAccessCrypto.ts";
import { checkShopifySignature } from "./shopifySignature.ts";
import { resolveAuditStart } from "./phases.ts";
import { AuditPhaseError } from "./errors.ts";
import { registerSiteAuditJob, setSiteAuditJobBindings } from "./job.ts";
import { runCrawlChunk } from "./crawlPhase.ts";
import { createMemoryAuditStore } from "./memoryStore.ts";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { runJob } from "../jobs/runner.ts";
import type { AuditRow } from "./store.ts";
import type { SafeFetchResult } from "../http/safeFetch.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const SIGNATURE_INPUT_SECRET = 'sig1=("@authority" "signature-agent");keyid="test-key"';
const SIGNATURE_SECRET = "sig1=:EXAMPLE-NOT-A-REAL-SIGNATURE:";

function testEnv(): Record<string, string | undefined> {
  return { CRAWLER_ACCESS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex") };
}

function jsonResult(body: unknown, status = 200): SafeFetchResult {
  const text = JSON.stringify(body);
  return {
    url: "https://shopify.com/.well-known/http-message-signatures-directory",
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(text),
    truncated: false,
    text: () => text,
    json: <T>() => JSON.parse(text) as T,
  };
}

function htmlResult(url: string): SafeFetchResult {
  const text =
    "<!DOCTYPE html><html><head><title>Page</title></head><body><h1>Page</h1></body></html>";
  return {
    url,
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    body: new TextEncoder().encode(text),
    truncated: false,
    text: () => text,
    json: <T>() => ({}) as T,
  };
}

function makeAudit(id: string, patch: Partial<AuditRow> = {}): AuditRow {
  return {
    id,
    brand_key: "qa-brand",
    job_id: null,
    status: "queued",
    current_phase: "queued",
    requested_url: "https://example.com/",
    start_url: "https://example.com/",
    start_host: "example.com",
    max_pages: 10,
    run_lighthouse: false,
    render_javascript: false,
    site_platform: null,
    robots_status: null,
    robots_txt: null,
    window_hint: 2,
    throttle_state: null,
    render_hold_id: null,
    render_approved_usd: null,
    render_attempts: 0,
    render_billed: 0,
    render_settled_at: null,
    lighthouse_approved_usd: null,
    pages_crawled: 0,
    pages_total: 10,
    pages_abandoned: 0,
    link_graph_complete: true,
    cancel_requested_at: null,
    created_at: "2026-11-16T09:00:00.000Z",
    started_at: null,
    completed_at: null,
    ...patch,
  };
}

interface CredentialRow {
  id: string;
  brand_key: string;
  host: string;
  provider: string;
  encrypted_signature_input: string;
  encrypted_signature: string;
  key_version: number;
  expires_at: string | null;
  created_at: string;
}

function credentialRow(patch: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "cred-1",
    brand_key: "brand-a",
    host: "shop.example.com",
    provider: "shopify",
    encrypted_signature_input: "sealed-input",
    encrypted_signature: "sealed-signature",
    key_version: 1,
    expires_at: null,
    created_at: "2026-11-16T09:00:00.000Z",
    ...patch,
  };
}

function memoryCredentialsAdmin(initial: CredentialRow[] = []) {
  const rows = new Map<string, CredentialRow>(initial.map((row) => [row.id, { ...row }]));
  const calls = {
    tables: [] as string[],
    selections: [] as string[],
    upserts: [] as Array<{ values: any; opts: any }>,
    deletes: 0,
  };

  const admin = {
    rows,
    calls,
    from(table: string) {
      calls.tables.push(table);
      let filters: Array<(row: CredentialRow) => boolean> = [];
      const matching = () => [...rows.values()].filter((row) => filters.every((f) => f(row)));

      const builder: any = {
        select(columns: string) {
          calls.selections.push(columns);
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => (row as any)[column] === value);
          return builder;
        },
        order(column: string, opts: { ascending?: boolean } = {}) {
          const direction = opts.ascending === false ? -1 : 1;
          const data = matching().sort((a, b) =>
            String((a as any)[column]) < String((b as any)[column]) ? -direction : direction,
          );
          return Promise.resolve({ data, error: null });
        },
        async maybeSingle() {
          return { data: matching()[0] ?? null, error: null };
        },
        async upsert(values: any, opts: any) {
          calls.upserts.push({ values, opts });
          const existing = [...rows.values()].find(
            (row) => row.brand_key === values.brand_key && row.host === values.host,
          );
          if (existing) {
            // PostgREST's ON CONFLICT DO UPDATE rewrites every payload column,
            // including id if a future change adds it. Keep this realistic: no
            // masking the primary key.
            const merged = { ...existing, ...values };
            rows.delete(existing.id);
            rows.set(merged.id, merged);
            return { data: [merged], error: null };
          }
          const inserted = {
            ...values,
            id: values.id ?? crypto.randomUUID(),
            created_at: values.created_at ?? "2026-11-16T09:00:00.000Z",
          };
          rows.set(inserted.id, inserted);
          return { data: [inserted], error: null };
        },
        delete() {
          const deleting: any = {
            eq(column: string, value: unknown) {
              filters.push((row) => (row as any)[column] === value);
              return deleting;
            },
            select: async () => {
              const victims = matching();
              for (const victim of victims) rows.delete(victim.id);
              calls.deletes += 1;
              return { data: victims.map((victim) => ({ id: victim.id })), error: null };
            },
          };
          return deleting;
        },
      };
      return builder;
    },
  };
  return admin;
}

// ---------------------------------------------------------------------------
// Ported pure helpers
// ---------------------------------------------------------------------------

const access = {
  host: "store.example.com",
  headers: shopifyCrawlerHeaders("sig1=(...)", "sig1=:abc:"),
  expiresAt: null,
};

test("crawlerHeadersFor sends the signature only to the audited host over https", () => {
  assert.deepEqual(crawlerHeadersFor("https://store.example.com/a", access), access.headers);
  for (const url of [
    "https://www.store.example.com/a",
    "http://store.example.com/a",
    "https://cdn.example.com/a",
    "https://evil.test/a",
  ]) {
    assert.deepEqual(crawlerHeadersFor(url, access), {}, url);
  }
});

test("crawlerHeadersFor stops sending the signature once it expires mid-crawl", () => {
  const expiresAt = "2026-11-16T10:00:00.000Z";
  const live = { ...access, expiresAt };
  assert.deepEqual(
    crawlerHeadersFor("https://store.example.com/a", live, Date.parse("2026-11-16T09:59:59.000Z")),
    access.headers,
  );
  assert.deepEqual(
    crawlerHeadersFor("https://store.example.com/a", live, Date.parse(expiresAt)),
    {},
  );
  assert.equal(isCrawlerAccessExpired(expiresAt, Date.parse(expiresAt)), true);
  assert.equal(isCrawlerAccessExpired(null), false);
});

test("normalizeCrawlerHost accepts a URL or bare host and rejects unusable input", () => {
  assert.equal(normalizeCrawlerHost("https://Shop.Example.COM./path"), "shop.example.com");
  assert.equal(normalizeCrawlerHost("shop.example.com"), "shop.example.com");
  assert.equal(normalizeCrawlerHost("h://5.6"), null);
  assert.equal(normalizeCrawlerHost("not a host"), null);
  assert.equal(normalizeCrawlerHost("localhost"), null);
  assert.equal(normalizeCrawlerHost(""), null);
});

test("parseSignatureExpiry reads ;expires=<unix seconds> only", () => {
  assert.equal(
    parseSignatureExpiry('sig1=("@authority");expires=1790000000;keyid="k"'),
    new Date(1790000000 * 1000).toISOString(),
  );
  assert.equal(parseSignatureExpiry('sig1=("@authority");keyid="k"'), null);
});

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

test("crawler field encryption round-trips and stores no plaintext", () => {
  const env = testEnv();
  const aad = crawlerAccessAad("brand-a", "shop.example.com", "signature_input");
  const envelope = encryptCrawlerField(SIGNATURE_INPUT_SECRET, aad, env);

  assert.equal(isCrawlerAccessConfigured(env), true);
  assert.equal(isCrawlerAccessConfigured({}), false);
  assert.equal(decryptCrawlerField(envelope, aad, env), SIGNATURE_INPUT_SECRET);
  assert.ok(!envelope.includes(SIGNATURE_INPUT_SECRET));
  const parsed = JSON.parse(envelope);
  assert.deepEqual(Object.keys(parsed).sort(), ["ciphertext", "keyVersion", "nonce", "tag"]);
  assert.equal(parsed.keyVersion, 1);
});

test("crawler field encryption binds the workspace, host and field into the AAD", () => {
  const env = testEnv();
  const envelope = encryptCrawlerField(
    SIGNATURE_INPUT_SECRET,
    crawlerAccessAad("brand-a", "shop.example.com", "signature_input"),
    env,
  );
  assert.throws(() =>
    decryptCrawlerField(
      envelope,
      crawlerAccessAad("brand-a", "other.example.com", "signature_input"),
      env,
    ),
  );
  assert.throws(() =>
    decryptCrawlerField(
      envelope,
      crawlerAccessAad("brand-a", "shop.example.com", "signature"),
      env,
    ),
  );
});

test("crawler field encryption fails a tampered tag and a missing key", () => {
  const env = testEnv();
  const aad = crawlerAccessAad("brand-a", "shop.example.com", "signature");
  const parsed = JSON.parse(encryptCrawlerField(SIGNATURE_SECRET, aad, env));
  const tag = Buffer.from(parsed.tag, "base64");
  tag[0] = tag[0] ^ 0xff;
  parsed.tag = tag.toString("base64");
  assert.throws(() => decryptCrawlerField(JSON.stringify(parsed), aad, env));

  assert.throws(
    () => encryptCrawlerField("x", aad, {}),
    (err: any) => err.code === "crawler_access_unavailable" && err.status === 503,
  );
  assert.throws(
    () => decryptCrawlerField("{}", aad, {}),
    (err: any) => err.code === "crawler_access_unavailable" && err.status === 503,
  );
});

// ---------------------------------------------------------------------------
// Shopify signature check
// ---------------------------------------------------------------------------

const shopifyKey = (await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
const shopifyPublicJwk = await crypto.subtle.exportKey("jwk", shopifyKey.publicKey);

async function signFor(domain: string, keyId = "test-key") {
  const params = `("@authority" "signature-agent");keyid="${keyId}"`;
  const base = `"@authority": ${domain}\n"signature-agent": ${SHOPIFY_SIGNATURE_AGENT}\n"@signature-params": ${params}`;
  const signed = await crypto.subtle.sign(
    "Ed25519",
    shopifyKey.privateKey,
    new TextEncoder().encode(base),
  );
  return {
    signatureInput: `sig1=${params}`,
    signature: `sig1=:${Buffer.from(signed).toString("base64")}:`,
  };
}

function directoryFetch(body: unknown) {
  return (async () => jsonResult(body)) as any;
}

test("shopifySignature accepts a signature made for the saved domain", async () => {
  const values = await signFor("shop.example.com");
  const problem = await checkShopifySignature(
    { host: "shop.example.com", ...values },
    { safeFetch: directoryFetch({ ...shopifyPublicJwk, kid: "test-key" }) },
  );
  assert.equal(problem, null);
});

test("shopifySignature names the www twin a signature was made for", async () => {
  const values = await signFor("www.shop.example.com");
  const problem = await checkShopifySignature(
    { host: "shop.example.com", ...values },
    { safeFetch: directoryFetch({ ...shopifyPublicJwk, kid: "test-key" }) },
  );
  assert.deepEqual(problem, {
    reason: "wrong_domain",
    host: "shop.example.com",
    signedHost: "www.shop.example.com",
  });
});

test("shopifySignature rejects an incomplete value and another store", async () => {
  const valid = await signFor("shop.example.com");
  const pastedTwice = await checkShopifySignature(
    { host: "shop.example.com", signatureInput: valid.signature, signature: valid.signature },
    { safeFetch: directoryFetch({ ...shopifyPublicJwk, kid: "test-key" }) },
  );
  assert.deepEqual(pastedTwice, { reason: "invalid", host: "shop.example.com" });

  const otherStore = await signFor("other-store.example.com");
  const wrongStore = await checkShopifySignature(
    { host: "shop.example.com", ...otherStore },
    { safeFetch: directoryFetch({ ...shopifyPublicJwk, kid: "test-key" }) },
  );
  assert.deepEqual(wrongStore, { reason: "invalid", host: "shop.example.com" });
});

test("shopifySignature never blocks a save when the directory is unreachable or rotated", async () => {
  const values = await signFor("shop.example.com");
  const unreachable = await checkShopifySignature(
    { host: "shop.example.com", ...values },
    {
      safeFetch: (async () => {
        throw new TypeError("fetch failed");
      }) as any,
    },
  );
  assert.equal(unreachable, null);

  const rotated = await checkShopifySignature(
    { host: "shop.example.com", ...values },
    { safeFetch: directoryFetch({ ...shopifyPublicJwk, kid: "a-newer-key" }) },
  );
  assert.equal(rotated, null);
});

test("shopifySignature uses the fixed directory with the safeFetch caps", async () => {
  const fixture = JSON.parse(
    readFileSync(path.join(REPO, "tests/fixtures/site-audit/shopify/directory.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(fixture).sort(), ["kid", "x"]);
  assert.equal(fixture.x.length, 43);

  let seenUrl = "";
  let seenInit: any = null;
  const values = await signFor("shop.example.com", "some-other-key");
  const problem = await checkShopifySignature(
    { host: "shop.example.com", ...values },
    {
      safeFetch: (async (url: string, init: any) => {
        seenUrl = url;
        seenInit = init;
        return jsonResult(fixture);
      }) as any,
    },
  );
  assert.equal(problem, null);
  assert.equal(seenUrl, "https://shopify.com/.well-known/http-message-signatures-directory");
  assert.equal(seenInit.timeoutMs, 5_000);
  assert.equal(seenInit.maxRedirects, 0);
  assert.equal(seenInit.maxBytes, 64 * 1024);
  assert.equal(seenInit.truncate, true);
});

// ---------------------------------------------------------------------------
// Credential service
// ---------------------------------------------------------------------------

test("listCrawlerCredentials reads summaries only, ordered by host", async () => {
  const admin = memoryCredentialsAdmin([
    credentialRow({ id: "cred-b", host: "z.example.com" }),
    credentialRow({ id: "cred-a", host: "a.example.com" }),
  ]);
  const credentials = await listCrawlerCredentials(admin, "brand-a", { env: testEnv() });
  assert.deepEqual(credentials.map((row) => row.host), ["a.example.com", "z.example.com"]);
  assert.deepEqual(credentials[0], {
    id: "cred-a",
    host: "a.example.com",
    provider: "shopify",
    createdAt: "2026-11-16T09:00:00.000Z",
    expiresAt: null,
  });
  assert.equal(admin.calls.selections[0], "id,host,provider,created_at,expires_at");
  assert.ok(!JSON.stringify(credentials).includes("encrypted"));
});

test("saveCrawlerCredential stores ciphertext and returns the summary", async () => {
  const env = testEnv();
  const admin = memoryCredentialsAdmin([]);
  const result = await saveCrawlerCredential(
    admin,
    {
      brandKey: "brand-a",
      userId: "user-a",
      host: "https://Shop.Example.com/",
      signatureInput: SIGNATURE_INPUT_SECRET,
      signature: SIGNATURE_SECRET,
      workspaceHost: "example.com",
    },
    { env, checkShopifySignature: async () => null },
  );
  assert.ok("credential" in result);
  assert.match(result.credential.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(
    { ...result.credential, id: "cred-1" },
    {
      id: "cred-1",
      host: "shop.example.com",
      provider: "shopify",
      createdAt: "2026-11-16T09:00:00.000Z",
      expiresAt: null,
    },
  );
  assert.equal(admin.calls.upserts.length, 1);
  assert.deepEqual(admin.calls.upserts[0].opts, { onConflict: "brand_key,host" });
  assert.equal(
    Object.hasOwn(admin.calls.upserts[0].values, "id"),
    false,
    "the upsert must not send a primary key: ON CONFLICT DO UPDATE would rewrite it",
  );
  const row = [...admin.rows.values()][0];
  assert.ok(row.encrypted_signature_input !== SIGNATURE_INPUT_SECRET);
  assert.ok(row.encrypted_signature !== SIGNATURE_SECRET);
  assert.ok(!JSON.stringify(row).includes(SIGNATURE_SECRET));
  assert.equal(
    decryptCrawlerField(
      row.encrypted_signature_input,
      crawlerAccessAad("brand-a", "shop.example.com", "signature_input"),
      env,
    ),
    SIGNATURE_INPUT_SECRET,
  );
});

test("saveCrawlerCredential replaces a second save for the same host", async () => {
  const env = testEnv();
  const admin = memoryCredentialsAdmin([]);
  const deps = { env, checkShopifySignature: async () => null };
  const firstSave = await saveCrawlerCredential(
    admin,
    {
      brandKey: "brand-a",
      userId: "user-a",
      host: "shop.example.com",
      signatureInput: 'sig1=(one);keyid="k"',
      signature: "sig1=:b25l:",
      workspaceHost: "example.com",
    },
    deps,
  );
  assert.ok("credential" in firstSave);
  const first = [...admin.rows.values()][0].encrypted_signature_input;
  const secondSave = await saveCrawlerCredential(
    admin,
    {
      brandKey: "brand-a",
      userId: "user-a",
      host: "shop.example.com",
      signatureInput: 'sig1=(two);keyid="k";expires=1790000000',
      signature: "sig1=:dHdvOg==:",
      workspaceHost: "example.com",
    },
    deps,
  );
  assert.ok("credential" in secondSave);
  assert.equal(secondSave.credential.id, firstSave.credential.id, "a re-save keeps the primary key");
  assert.equal(admin.rows.size, 1);
  const row = [...admin.rows.values()][0];
  assert.equal(row.id, firstSave.credential.id);
  assert.notEqual(row.encrypted_signature_input, first);
  assert.equal(row.expires_at, new Date(1790000000 * 1000).toISOString());
});

test("saveCrawlerCredential refuses unusable and unowned hosts before any network call", async () => {
  const env = testEnv();
  const admin = memoryCredentialsAdmin([]);
  let checks = 0;
  const deps = {
    env,
    checkShopifySignature: async () => {
      checks += 1;
      return null;
    },
  };

  const invalid = await saveCrawlerCredential(
    admin,
    {
      brandKey: "brand-a",
      userId: "user-a",
      host: "h://5.6",
      signatureInput: SIGNATURE_INPUT_SECRET,
      signature: SIGNATURE_SECRET,
      workspaceHost: "example.com",
    },
    deps,
  );
  assert.deepEqual(invalid, { problem: { reason: "invalid_host", host: "h://5.6" } });

  const unowned = await saveCrawlerCredential(
    admin,
    {
      brandKey: "brand-a",
      userId: "user-a",
      host: "someone-else.test",
      signatureInput: SIGNATURE_INPUT_SECRET,
      signature: SIGNATURE_SECRET,
      workspaceHost: "example.com",
    },
    deps,
  );
  assert.deepEqual(unowned, {
    problem: {
      reason: "audit_host_not_owned",
      host: "someone-else.test",
      workspaceHost: "example.com",
    },
  });
  assert.equal(checks, 0);
  assert.equal(admin.calls.upserts.length, 0);

  const allowed = await saveCrawlerCredential(
    admin,
    {
      brandKey: "brand-a",
      userId: "user-a",
      host: "someone-else.test",
      signatureInput: SIGNATURE_INPUT_SECRET,
      signature: SIGNATURE_SECRET,
      workspaceHost: "example.com",
    },
    { ...deps, env: { ...env, SITE_AUDIT_ALLOW_ANY_HOST: "on" } },
  );
  assert.ok("credential" in allowed);
});

test("saveCrawlerCredential returns a signature problem without storing anything", async () => {
  const admin = memoryCredentialsAdmin([]);
  const result = await saveCrawlerCredential(
    admin,
    {
      brandKey: "brand-a",
      userId: "user-a",
      host: "shop.example.com",
      signatureInput: SIGNATURE_INPUT_SECRET,
      signature: SIGNATURE_SECRET,
      workspaceHost: "example.com",
    },
    {
      env: testEnv(),
      checkShopifySignature: async () => ({
        reason: "wrong_domain",
        host: "shop.example.com",
        signedHost: "www.shop.example.com",
      }),
    },
  );
  assert.deepEqual(result, {
    problem: {
      reason: "wrong_domain",
      host: "shop.example.com",
      signedHost: "www.shop.example.com",
    },
  });
  assert.equal(admin.calls.upserts.length, 0);
});

test("saveCrawlerCredential fails closed with 503 before any DB read when the key is missing", async () => {
  const admin = memoryCredentialsAdmin([]);
  let checks = 0;
  await assert.rejects(
    saveCrawlerCredential(
      admin,
      {
        brandKey: "brand-a",
        userId: "user-a",
        host: "shop.example.com",
        signatureInput: SIGNATURE_INPUT_SECRET,
        signature: SIGNATURE_SECRET,
        workspaceHost: "example.com",
      },
      {
        env: {},
        checkShopifySignature: async () => {
          checks += 1;
          return null;
        },
      },
    ),
    (err: any) =>
      err.status === 503 &&
      err.code === "crawler_access_unavailable" &&
      err.message === "Shopify crawler access is unavailable right now. Please retry.",
  );
  assert.equal(admin.calls.tables.length, 0);
  assert.equal(checks, 0);
});

test("deleteCrawlerCredential is scoped by workspace and reports whether a row went", async () => {
  const admin = memoryCredentialsAdmin([
    credentialRow({ id: "cred-a", brand_key: "brand-a" }),
    credentialRow({ id: "cred-b", brand_key: "brand-b" }),
  ]);
  assert.equal(await deleteCrawlerCredential(admin, "brand-a", "cred-b"), false);
  assert.equal(admin.rows.size, 2);
  assert.equal(await deleteCrawlerCredential(admin, "brand-a", "cred-a"), true);
  assert.deepEqual([...admin.rows.keys()], ["cred-b"]);
});

test("resolveCrawlerAccess returns an unexpired row and skips an expired one", async () => {
  const live = memoryCredentialsAdmin([credentialRow()]);
  const found = await resolveCrawlerAccess(live, "brand-a", "shop.example.com");
  assert.ok(found);
  assert.equal(found.id, "cred-1");
  assert.deepEqual(found.sealed, {
    brandKey: "brand-a",
    host: "shop.example.com",
    signatureInput: "sealed-input",
    signature: "sealed-signature",
    expiresAt: null,
  });

  const expired = memoryCredentialsAdmin([
    credentialRow({ expires_at: "2020-01-01T00:00:00.000Z" }),
  ]);
  assert.equal(await resolveCrawlerAccess(expired, "brand-a", "shop.example.com"), null);
});

test("openCrawlerAccess decrypts the replay headers in memory only", async () => {
  const env = testEnv();
  const sealed: SealedCrawlerAccess = {
    brandKey: "brand-a",
    host: "shop.example.com",
    signatureInput: encryptCrawlerField(
      SIGNATURE_INPUT_SECRET,
      crawlerAccessAad("brand-a", "shop.example.com", "signature_input"),
      env,
    ),
    signature: encryptCrawlerField(
      SIGNATURE_SECRET,
      crawlerAccessAad("brand-a", "shop.example.com", "signature"),
      env,
    ),
    expiresAt: null,
  };
  const opened = await openCrawlerAccess(sealed, { env });
  assert.deepEqual(opened, {
    host: "shop.example.com",
    expiresAt: null,
    headers: shopifyCrawlerHeaders(SIGNATURE_INPUT_SECRET, SIGNATURE_SECRET),
  });
});

test("openCrawlerAccess crawls unsigned on decrypt failure and names only the host", async () => {
  const warnings: string[] = [];
  const opened = await openCrawlerAccess(
    {
      brandKey: "brand-a",
      host: "shop.example.com",
      signatureInput: "not-a-valid-envelope",
      signature: "not-a-valid-envelope",
      expiresAt: null,
    },
    { env: testEnv(), warn: (message) => warnings.push(message) },
  );
  assert.equal(opened, null);
  assert.deepEqual(warnings, ["[audit] crawler access unreadable host=shop.example.com"]);
  assert.ok(!warnings.join("\n").includes("not-a-valid-envelope"));
});

test("openCrawlerAccess fails closed when the key is missing", async () => {
  await assert.rejects(
    openCrawlerAccess(
      {
        brandKey: "brand-a",
        host: "shop.example.com",
        signatureInput: "sealed",
        signature: "sealed",
        expiresAt: null,
      },
      { env: {} },
    ),
    (err: any) => err.status === 503 && err.code === "crawler_access_unavailable",
  );
});

test("openCrawlerAccess refuses a credential moved to another host", async () => {
  const env = testEnv();
  const sealed: SealedCrawlerAccess = {
    brandKey: "brand-a",
    host: "shop.example.com",
    signatureInput: encryptCrawlerField(
      SIGNATURE_INPUT_SECRET,
      crawlerAccessAad("brand-a", "shop.example.com", "signature_input"),
      env,
    ),
    signature: encryptCrawlerField(
      SIGNATURE_SECRET,
      crawlerAccessAad("brand-a", "shop.example.com", "signature"),
      env,
    ),
    expiresAt: null,
  };
  const warnings: string[] = [];
  const opened = await openCrawlerAccess(
    { ...sealed, host: "attacker.example.com" },
    { env, warn: (message) => warnings.push(message) },
  );
  assert.equal(opened, null);
  assert.deepEqual(warnings, ["[audit] crawler access unreadable host=attacker.example.com"]);
});

// ---------------------------------------------------------------------------
// Start wiring
// ---------------------------------------------------------------------------

function startFetch(options: {
  poweredBy?: string | null;
  status?: number;
  redirectTo?: string;
}) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetcher = (async (url: string, init: any): Promise<SafeFetchResult> => {
    calls.push({ url, init });
    const headers = new Headers();
    if (options.poweredBy) headers.set("powered-by", options.poweredBy);
    if (options.redirectTo) headers.set("location", options.redirectTo);
    return {
      url,
      status: options.status ?? (options.redirectTo ? 301 : 200),
      headers,
      body: new Uint8Array(0),
      truncated: false,
      text: () => "",
      json: <T>() => ({}) as T,
    };
  }) as any;
  return { fetcher, calls };
}

test("resolveAuditStart resolves the credential for the final host and signs no probe", async () => {
  const env = testEnv();
  const { fetcher, calls } = startFetch({ redirectTo: "https://www.example.com/" });
  const hosts: string[] = [];
  const sealed: SealedCrawlerAccess = {
    brandKey: "qa-brand",
    host: "www.example.com",
    signatureInput: "sealed",
    signature: "sealed",
    expiresAt: null,
  };

  const resolved = await resolveAuditStart(makeAudit("audit-1"), {
    safeFetch: fetcher,
    lookup: async () => ["93.184.216.34"],
    env,
    resolveCrawlerAccess: async (_admin, _brandKey, host) => {
      hosts.push(host);
      return { id: "cred-9", sealed };
    },
  });

  assert.deepEqual(resolved, {
    startUrl: "https://www.example.com/",
    origin: "https://www.example.com",
    sitePlatform: "shopify",
    crawlerCredentialId: "cred-9",
  });
  assert.deepEqual(hosts, ["www.example.com"]);
  for (const call of calls) {
    const headerNames = [...new Headers(call.init?.headers ?? {}).keys()];
    assert.ok(
      headerNames.every((name) => !/^signature/i.test(name)),
      "the start probe must not carry a crawler signature",
    );
  }
});

test("resolveAuditStart records Shopify for a throttled probe when a credential exists", async () => {
  const { fetcher } = startFetch({ status: 429 });
  const resolved = await resolveAuditStart(makeAudit("audit-2"), {
    safeFetch: fetcher,
    lookup: async () => ["93.184.216.34"],
    env: testEnv(),
    resolveCrawlerAccess: async () => ({
      id: "cred-1",
      sealed: {
        brandKey: "qa-brand",
        host: "example.com",
        signatureInput: "sealed",
        signature: "sealed",
        expiresAt: null,
      },
    }),
  });
  assert.equal(resolved.sitePlatform, "shopify");
  assert.equal(resolved.crawlerCredentialId, "cred-1");
});

test("resolveAuditStart skips an expired credential and records nothing", async () => {
  const { fetcher } = startFetch({});
  const admin = memoryCredentialsAdmin([
    credentialRow({
      brand_key: "qa-brand",
      host: "example.com",
      expires_at: "2020-01-01T00:00:00.000Z",
    }),
  ]);
  const resolved = await resolveAuditStart(makeAudit("audit-3"), {
    safeFetch: fetcher,
    lookup: async () => ["93.184.216.34"],
    admin,
  });
  assert.equal(resolved.crawlerCredentialId, null);
  assert.equal(resolved.sitePlatform, null);
});

test("resolveAuditStart fails closed when a live credential has no key", async () => {
  const { fetcher } = startFetch({});
  await assert.rejects(
    resolveAuditStart(makeAudit("audit-4"), {
      safeFetch: fetcher,
      lookup: async () => ["93.184.216.34"],
      env: {},
      resolveCrawlerAccess: async () => ({
        id: "cred-1",
        sealed: {
          brandKey: "qa-brand",
          host: "example.com",
          signatureInput: "sealed",
          signature: "sealed",
          expiresAt: null,
        },
      }),
    }),
    (err: unknown) =>
      err instanceof AuditPhaseError &&
      err.code === "start_failed" &&
      err.phase === "starting",
  );
});

test("secrets: logs from save, list, resolve, open, crawl and decrypt failure carry no values", async () => {
  const env = testEnv();
  const admin = memoryCredentialsAdmin([]);
  const logged: string[] = [];
  const capture = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await saveCrawlerCredential(
      admin,
      {
        brandKey: "brand-a",
        userId: "user-a",
        host: "shop.example.com",
        signatureInput: SIGNATURE_INPUT_SECRET,
        signature: SIGNATURE_SECRET,
        workspaceHost: "example.com",
      },
      { env, checkShopifySignature: async () => null },
    );
    await listCrawlerCredentials(admin, "brand-a", { env });
    const resolved = await resolveCrawlerAccess(admin, "brand-a", "shop.example.com");
    if (!resolved) throw new Error("the saved credential must resolve");
    await openCrawlerAccess(resolved.sealed, { env });

    const crawlStore = createMemoryAuditStore();
    const crawlId = "00000000-0000-4000-8000-0000000000c9";
    crawlStore.seedAudit(makeAudit(crawlId, { crawler_credential_id: resolved.id }));
    await crawlStore.seedStart(crawlId, "https://example.com/");
    await runCrawlChunk({
      auditId: crawlId,
      chunkNo: 1,
      jobId: "job-log",
      store: crawlStore,
      deps: {
        initialIntervalMs: 0,
        safeFetch: async (url: any) => htmlResult(url.toString()),
        lookup: async () => ["93.184.216.34"],
        env,
        resolveCrawlerAccess: async () => ({ id: resolved.id, sealed: resolved.sealed }),
      },
    });

    await openCrawlerAccess(
      {
        brandKey: "brand-a",
        host: "shop.example.com",
        signatureInput: "corrupt",
        signature: "corrupt",
        expiresAt: null,
      },
      { env },
    );
  } finally {
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  }

  const text = logged.join("\n");
  assert.ok(!text.includes(SIGNATURE_INPUT_SECRET));
  assert.ok(!text.includes(SIGNATURE_SECRET));
  assert.ok(!text.includes(env.CRAWLER_ACCESS_ENCRYPTION_KEY!));
  assert.ok(!text.includes("ciphertext"));
  assert.ok(text.includes("[audit] crawler access unreadable host=shop.example.com"));
  for (const line of logged) {
    assert.ok(!line.includes("encrypted_signature"));
  }
});

test("secrets: resolve-start and crawl-chunk step outputs carry no signature values", async () => {
  const env = testEnv();
  const auditStore = createMemoryAuditStore();
  const jobStore = createMemoryJobStore();
  const auditId = "00000000-0000-4000-8000-0000000000c1";

  auditStore.seedAudit(
    makeAudit(auditId, {
      crawler_credential_id: "cred-1",
      site_platform: null,
    }),
  );

  const sealed: SealedCrawlerAccess = {
    brandKey: "qa-brand",
    host: "example.com",
    signatureInput: encryptCrawlerField(
      SIGNATURE_INPUT_SECRET,
      crawlerAccessAad("qa-brand", "example.com", "signature_input"),
      env,
    ),
    signature: encryptCrawlerField(
      SIGNATURE_SECRET,
      crawlerAccessAad("qa-brand", "example.com", "signature"),
      env,
    ),
    expiresAt: null,
  };

  const mockSafeFetch = async (targetUrl: string | URL): Promise<SafeFetchResult> => {
    const url = targetUrl.toString();
    if (url === "https://example.com/robots.txt") {
      const text = "User-agent: *\nAllow: /";
      return {
        url,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: new TextEncoder().encode(text),
        truncated: false,
        text: () => text,
        json: <T>() => ({}) as T,
      };
    }
    const html =
      url === "https://example.com/"
        ? "<!DOCTYPE html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>"
        : "<!DOCTYPE html><html><head><title>Page</title></head><body><h1>Page</h1></body></html>";
    return {
      url,
      status: url === "https://example.com/llms.txt" ? 404 : 200,
      headers: new Headers({ "content-type": url.endsWith(".txt") ? "text/plain" : "text/html" }),
      body: new TextEncoder().encode(html),
      truncated: false,
      text: () => html,
      json: <T>() => ({}) as T,
    };
  };

  setSiteAuditJobBindings(auditStore, null, {
    safeFetch: mockSafeFetch,
    lookup: async () => ["93.184.216.34"],
    initialIntervalMs: 0,
    env,
    resolveCrawlerAccess: async () => ({ id: "cred-1", sealed }),
  });
  registerSiteAuditJob();

  const { jobId } = await jobStore.enqueue({
    kind: "site_audit.run",
    brandKey: "qa-brand",
    payload: { auditId },
    trigger: "manual",
    dedupeKey: null,
    singleActiveKey: null,
    runAt: null,
    createdBy: null,
    deadlineSeconds: 3600,
    maxInvocations: 10,
  });
  const claimed = await jobStore.claimDue("worker:1", 1, 300, jobId);
  assert.equal(claimed.length, 1);
  const outcome = await runJob(claimed[0], {
    store: jobStore,
    owner: "worker:1",
    deadlineMs: Date.now() + 3_600_000,
    now: () => Date.now(),
    selfContinue: () => {},
  });
  assert.equal(outcome, "completed");

  const row = await auditStore.getAudit(auditId);
  assert.equal(row?.crawler_credential_id, "cred-1");
  assert.equal(row?.site_platform, "shopify");

  const resolveOutput = jobStore.steps.get(`${jobId}:resolve-start`)?.output;
  assert.deepEqual(resolveOutput, {
    startUrl: "https://example.com/",
    origin: "https://example.com",
    sitePlatform: "shopify",
  });
  const chunkOutput = jobStore.steps.get(`${jobId}:crawl-chunk-1`)?.output;
  const finished = await jobStore.getJob(jobId!);
  const serialized = JSON.stringify([resolveOutput, chunkOutput, finished?.result]);
  assert.ok(!serialized.includes(SIGNATURE_INPUT_SECRET));
  assert.ok(!serialized.includes(SIGNATURE_SECRET));
  assert.ok(!serialized.includes("sig1"));

  setSiteAuditJobBindings(null, null, undefined);
});
