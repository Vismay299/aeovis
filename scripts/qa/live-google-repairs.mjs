#!/usr/bin/env node
// Deliberate bounded live acceptance. No application database is constructed.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const args = process.argv.slice(2);
const redactionCheck=args.at(-1)==="--redaction-check";
if(redactionCheck)args.pop();
if (args.join(" ") !== "--property https://perceev.ai --max-requests 2")
  throw Error(
    "This acceptance command requires the authorized Perceev property and a two-query ceiling",
  );
for (const name of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
])
  delete process.env[name];
const { brightDataSearch } = await import(
  "../../src/lib/engines/brightdata.js"
);
const { evidenceDocument } = await import(
  "../../src/lib/db/measurementEvidence.js"
);
const {parseGoogleSerp}=await import("../../src/lib/engines/googlePayload.js");
const {classifyProviderFailure}=await import("../../src/lib/engines/providerFailure.js");
const directory = "/tmp/aeovis-google-live-repairs";
await mkdir(directory, { recursive: true, mode: 0o700 });
const rows = [];
const originalFetch = globalThis.fetch;
let requestsSent = 0,
  controlRequests = 0;
globalThis.fetch = async (url, init) => {
  const target = new URL(typeof url === "string" ? url : url.url);
  if (target.hostname !== "api.brightdata.com")
    throw Error("Live acceptance refused an unexpected network destination");
  if (target.pathname === "/request") {
    if (requestsSent >= 2) throw Error("Live request ceiling reached");
    requestsSent++;
  } else {
    if (controlRequests >= 1) throw Error("Control request ceiling reached");
    controlRequests++;
  }
  return originalFetch(url, init);
};
for (const query of [
  "What is AI answer engine visibility measurement?",
  "site:perceev.ai privacy policy",
]) {
  const captures = [];
  const documents = [];
  const started = new Date().toISOString();
  try {
    const result = await brightDataSearch(query, {
      geo: "in",
      measurementContext: {
        country: "in",
        language: "en",
        device: "desktop",
        session_policy: "fresh_anonymous",
      },
      attempts: 1,
      durableDispatch: true,
      deadlineAt: Date.now() + 70000,
      captureEvidence: async (input) => {
        const doc = evidenceDocument(input);
        documents.push(doc.document);
        const path = `${directory}/${doc.hash}.json`;
        await writeFile(path, doc.body, { mode: 0o600 });
        captures.push({
          sha256: doc.hash,
          private_qa_file: path,
          bytes: Buffer.byteLength(doc.body),
        });
      },
    });
    if(redactionCheck)for(const document of documents){
      const replay=parseGoogleSerp(document.payload);
      assert.equal(replay.serp_state,result.serp_validation.serp_state);
      assert.equal(replay.aio_present,result.serp_validation.aio_present);
      assert.equal(replay.text,result.serp_validation.text);
      assert.deepEqual(replay.references,result.serp_validation.references);
    }
    rows.push({
      query,
      started_at: started,
      finished_at: new Date().toISOString(),
      surface: "google_serp_aio",
      requested_country: "in",
      observed_location: null,
      parser_version:
        result.serp_validation?.parser_version || result.parser_version || null,
      validation: result.serp_validation || null,
      request_id:
        result.serp_validation?.provider_request_id ||
        result.provider_request_id ||
        null,
      state:
        result.serp_validation?.serp_state === "valid_serp"
          ? result.serp_validation.aio_present
            ? "aio_present"
            : "valid_no_aio"
          : "unverified",
      captures,
      redaction_replay:redactionCheck ? "passed" : "not_run",
    });
  } catch (error) {
    rows.push({
      query,
      started_at: started,
      finished_at: new Date().toISOString(),
      surface: "google_serp_aio",
      state: "failed",
      failure_kind: error.provider_failure?.kind || classifyProviderFailure({provider:"brightdata",error}).kind,
      parser_state: error.serp_state || null,
      captures,
    });
  }
}
const manifest = {
  kind: "bounded-live-google-acceptance",
  property: "https://perceev.ai",
  executed_at: new Date().toISOString(),
  query_ceiling: 2,
  retries: false,
  zone_lookup_request_ceiling: 1,
  requests_sent: requestsSent,
  control_requests_sent: controlRequests,
  spend:
    "Provider billing not exposed by SERP responses; two query calls were authorized. No spend total is invented.",
  storage:
    "Private local QA snapshots; hosted Storage qualification remains separate.",
  other_surfaces: {
    chatgpt: "not_assessed_in_this_google_only_run; see p0-hosted-provider-evidence.json",
    perplexity: "not_assessed_in_this_google_only_run; see p0-hosted-provider-evidence.json",
    gemini: "not_assessed_in_this_google_only_run; see p0-hosted-provider-evidence.json",
  },
  observations: rows,
};
await writeFile(
  redactionCheck ? "docs/audits/2026-10-16/p0-google-redaction-live-evidence.json" : "docs/audits/2026-10-16/repair-google-live-evidence.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify({executed_at:manifest.executed_at,requests_sent:requestsSent,observations:rows.map(r=>({state:r.state,failure_kind:r.failure_kind||null,redaction_replay:r.redaction_replay||null,captures:r.captures.length}))}));
