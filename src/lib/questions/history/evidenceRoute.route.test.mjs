import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../../customerRoutes.test.hooks.mjs", import.meta.url).href);

const route = await import("../../../app/api/customer/measurement/evidence/route.js");

const BRAND_A = "workspace-a";
const BRAND_B = "workspace-b";

function makeAdmin() {
  const observations = [
    { id: "obs-scan-1", purpose: "scan", brand_key: null, job_brand: BRAND_A },
    { id: "obs-explore-1", purpose: "explore", brand_key: BRAND_A, job_brand: null },
    { id: "obs-other-1", purpose: "explore", brand_key: BRAND_B, job_brand: null },
  ];
  const evidence = [
    {
      observation_id: "obs-scan-1",
      attempt_token: "att-1",
      capture_index: 0,
      state: "stored",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      reason: null,
      object_key: "captures/obs-scan-1/0",
    },
    {
      observation_id: "obs-explore-1",
      attempt_token: "att-1",
      capture_index: 0,
      state: "stored",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      reason: null,
      object_key: "captures/obs-explore-1/0",
    },
    {
      observation_id: "obs-scan-1",
      attempt_token: "att-withdrawn",
      capture_index: 0,
      state: "stored",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      reason: "redaction_retracted",
      object_key: "captures/withdrawn/0",
    },
    {
      observation_id: "obs-scan-1",
      attempt_token: "att-expired",
      capture_index: 0,
      state: "stored",
      expires_at: new Date(Date.now() - 3600_000).toISOString(),
      reason: null,
      object_key: "captures/expired/0",
    },
    {
      observation_id: "obs-scan-1",
      attempt_token: "att-incomplete",
      capture_index: 0,
      state: "pending",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      reason: null,
      object_key: "captures/pending/0",
    },
  ];
  const admin = {
    from(table) {
      let rows = [];
      if (table === "probe_observations") rows = observations.slice();
      if (table === "measurement_evidence") rows = evidence.slice();
      const query = {
        select: () => query,
        eq: (col, value) => {
          if (table === "probe_observations" && col === "scan_jobs.brand_key") {
            rows = rows.filter((row) => row.job_brand === value && row.purpose === "scan");
          } else {
            rows = rows.filter((row) => row[col] === value);
          }
          return query;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return query;
    },
    storage: {
      from: () => ({
        createSignedUrl: async (key) => ({ data: { signedUrl: `https://signed.example/${key}` }, error: null }),
      }),
    },
  };
  return admin;
}

function fixture() {
  const admin = makeAdmin();
  globalThis.customerRouteFixture = {
    admin,
    context: {
      client: null,
      user: { id: "user-a" },
      error: null,
      brands: [{ brandKey: BRAND_A, display_name: "Workspace", website: "https://a.example", role: "owner" }],
    },
  };
}

function url(params) {
  const search = new URLSearchParams({ brand_key: BRAND_A, ...params });
  return new Request(`https://app.test/api/customer/measurement/evidence?${search.toString()}`);
}

test("scan observation keeps byte-identical 404/409/410 copy", async () => {
  fixture();
  const missing = await route.GET(url({ observation: "obs-missing", attempt: "att-1", index: "0" }));
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Evidence unavailable");

  const withdrawn = await route.GET(url({ observation: "obs-scan-1", attempt: "att-withdrawn", index: "0" }));
  assert.equal(withdrawn.status, 410);
  assert.equal(
    await withdrawn.text(),
    "This capture was withdrawn because its redaction could not be verified. The measurement is retained.",
  );

  const expired = await route.GET(url({ observation: "obs-scan-1", attempt: "att-expired", index: "0" }));
  assert.equal(expired.status, 410);
  assert.equal(await expired.text(), "Raw capture expired under the retention policy. The measurement is retained.");

  const incomplete = await route.GET(url({ observation: "obs-scan-1", attempt: "att-incomplete", index: "0" }));
  assert.equal(incomplete.status, 409);
  assert.equal(await incomplete.text(), "This capture was not stored. The observation has incomplete evidence.");
});

test("explore observation of the same workspace redirects, another workspace 404s", async () => {
  fixture();
  const own = await route.GET(url({ observation: "obs-explore-1", attempt: "att-1", index: "0" }));
  assert.equal(own.status, 302);
  assert.ok(String(own.headers.get("Location")).includes("signed.example"));

  const other = await route.GET(
    new Request(
      `https://app.test/api/customer/measurement/evidence?brand_key=${BRAND_A}&observation=obs-other-1&attempt=att-1&index=0`,
    ),
  );
  assert.equal(other.status, 404);
  assert.equal(await other.text(), "Evidence unavailable");
});
