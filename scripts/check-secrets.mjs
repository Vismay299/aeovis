#!/usr/bin/env node
/**
 * check:secrets — the smallest possible LIVE call per vendor (R0.1.6, S20).
 *
 * /api/health reports whether a credential is CONFIGURED. This reports whether
 * it WORKS, which is a different and more useful question: the failure this
 * closes is a deployment where every env var is set, every health check is
 * green, and the key is revoked — a scan then produces a plausible-looking
 * result built on nothing.
 *
 * Rules this script follows, because it exists to tell the truth about state:
 *   - Exactly three verdicts. UNCONFIGURED (no credential) is NOT a pass and
 *     NOT a failure; it is a third thing, and it must look different from both.
 *   - Exit code is non-zero only when a CONFIGURED vendor fails, or when the
 *     engine-advertising check below finds the landing page naming an engine
 *     the fleet will skip (R2.10.1). An unconfigured optional vendor must not
 *     break a deploy gate; a page that lies about coverage should.
 *   - Every call is the cheapest read the vendor offers, with a hard timeout.
 *     Nothing here creates, writes, or spends more than a token or two.
 *
 * Usage:
 *   npm run check:secrets              # reads .env.local
 *   node scripts/check-secrets.mjs     # reads the ambient environment
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { LLM_ENV, getLlmApiKey, getLlmBaseUrl, getLlmModel, getLlmProvider } from "../src/lib/llmConfig.js";
// R0.1.10 — the client's OWN zone resolver, so this check is on the same code
// path every probe uses rather than a mirror of it.
import { resolveBrightDataSerpZone } from "../src/lib/engines/brightdata.js";
import {
  ENGINE_LABELS,
  deployedEngines,
  engineDriftWarning,
  formatEngineList,
  parseEngineList,
} from "../src/lib/engines/deployedEngines.js";

const PASS = "PASS";
const FAIL = "FAIL";
const UNCONFIGURED = "UNCONFIGURED";

const TIMEOUT_MS = Number(process.env.CHECK_SECRETS_TIMEOUT_MS || 20000);

const env = (name) => String(process.env[name] || "").trim();

/** fetch with a hard deadline — a hung vendor must not hang the check. */
async function get(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * Turn an HTTP response into a verdict, naming the status on failure.
 *
 * `failContext` names WHO answered, and only the failure path needs it: a PASS
 * detail already says. It exists because a 402 reading "Insufficient account
 * balance" from a gateway configured as MiMo was read for a week as an
 * OpenRouter billing problem, and the fix attempted was rotating an OpenRouter
 * key that nothing calls. The host is the one fact that disambiguates it.
 */
async function fromResponse(res, okDetail, failContext = "") {
  if (res.ok) return { verdict: PASS, detail: okDetail };
  const body = await res.text().catch(() => "");
  const who = failContext ? ` from ${failContext}` : "";
  return { verdict: FAIL, detail: `HTTP ${res.status}${who}${body ? ` — ${body.slice(0, 120)}` : ""}` };
}

/**
 * One entry per vendor. `keys` are the env vars it needs; when any is missing
 * the vendor is UNCONFIGURED and `check` is never called. `anyKeys` is the
 * either/or form for a credential with a deprecated alias: at least one must
 * be set, and the FIRST (canonical) one is what an operator is told to set.
 */
export const VENDORS = [
  {
    name: "supabase",
    required: true,
    keys: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    // PostgREST select-1: no rows returned, cheapest possible round trip.
    async check() {
      const res = await get(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/scans?select=id&limit=1`, {
        headers: {
          apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
          Authorization: `Bearer ${env("NEXT_PUBLIC_SUPABASE_ANON_KEY")}`,
        },
      });
      return fromResponse(res, "select 1 from scans");
    },
  },
  {
    name: "brightdata",
    required: true,
    keys: ["BRIGHTDATA_API_KEY"],
    // R0.1.10 (finding C4) — validate the credential the CLIENT will use, by
    // ASKING THE CLIENT, not by reproducing its reasoning here.
    //
    // Two rounds of this check have now been wrong in the same way. The first
    // called get_all_zones and passed if ANY active serp zone existed, never
    // reading BRIGHTDATA_SERP_ZONE — so a typo'd zone reported PASS on an
    // account with a healthy zone list and not one working probe. The second
    // read the variable and re-picked the zone inline, which is a MIRROR of
    // brightdata.js, and a mirror is exactly what drifted into C4 the first
    // time. It could also still lie: it validated its own `serp[0]` while the
    // client picks from a separate, later call, and nothing makes two
    // get_all_zones responses agree on order.
    //
    // So the zone under test is now `resolveBrightDataSerpZone()`'s actual
    // return value — the same function, with the same env short-circuit and the
    // same cache, that every probe goes through. There is one code path and
    // this check is on it. It throws on a no-active-zone account, which main()'s
    // catch turns into a FAIL, so that branch gets stronger rather than weaker.
    async check() {
      const res = await get("https://api.brightdata.com/zone/get_all_zones", {
        headers: { Authorization: `Bearer ${env("BRIGHTDATA_API_KEY")}` },
      });
      if (!res.ok) return fromResponse(res, undefined, "api.brightdata.com");

      const zones = (await res.json().catch(() => [])) || [];
      const serp = zones.filter((z) => z.type === "serp" && z.status === "active");
      const configured = (process.env.BRIGHTDATA_SERP_ZONE || "").trim();

      let zone;
      try {
        zone = await resolveBrightDataSerpZone(env("BRIGHTDATA_API_KEY"));
      } catch (err) {
        return { verdict: FAIL, detail: `${err.message} Every AIO probe will fail.` };
      }
      if (!zone) {
        return { verdict: FAIL, detail: "no SERP zone could be resolved — every AIO probe will fail" };
      }

      const match = zones.find((z) => z.name === zone);
      if (!match) {
        return {
          verdict: FAIL,
          detail:
            `BRIGHTDATA_SERP_ZONE="${zone}" does not exist on this account. ` +
            `Every AIO probe will fail. Active serp zones: ${
              serp.map((z) => z.name).join(", ") || "(none)"
            }`,
        };
      }
      if (match.status !== "active" || match.type !== "serp") {
        return {
          verdict: FAIL,
          detail:
            `BRIGHTDATA_SERP_ZONE="${zone}" exists but is type=${match.type} ` +
            `status=${match.status}, not an active serp zone. Every AIO probe will fail.`,
        };
      }

      if (configured) {
        return { verdict: PASS, detail: `configured zone "${zone}" is an active serp zone` };
      }
      // Unset is not UNCONFIGURED: the credential is present and works, and the
      // variable is documented as optional. But the operator should know the
      // name was picked FOR them, and that it is then cached for the life of
      // the process with no invalidator (R1.2.7) — a zone that dies mid-run
      // keeps being used, and this check runs in a different process from the
      // worker, so it can report the truth while the worker acts on a stale answer.
      return {
        verdict: PASS,
        detail:
          `${serp.length} active serp zone(s); no BRIGHTDATA_SERP_ZONE set, so probes ` +
          `AUTO-DISCOVERED "${zone}" and will cache it for the process lifetime`,
      };
    },
  },
  {
    name: "llm",
    required: true,
    // LLM_API_KEY is canonical; OPENROUTER_API_KEY still configures the vendor
    // as a deprecated alias (R5.1.1). Either one makes this CONFIGURED, and
    // the report names the canonical one when neither is set.
    keys: [],
    anyKeys: [LLM_ENV.apiKey.canonical, LLM_ENV.apiKey.legacy],
    // One token against the configured model. Also proves the MODEL is valid
    // on this gateway, which a key check alone does not: a model id valid on
    // one OpenAI-compatible gateway is routinely invalid on another.
    async check() {
      const base = getLlmBaseUrl(process.env);
      const model = getLlmModel(process.env);
      const provider = getLlmProvider(base);
      // Mirror the client's per-gateway request shape (src/lib/openrouter.js):
      // MiMo reads max_completion_tokens rather than max_tokens, so probing it
      // with the portable spelling can report FAIL on a working deployment.
      const cap = provider === "mimo" ? { max_completion_tokens: 1 } : { max_tokens: 1 };
      const res = await get(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getLlmApiKey(process.env)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...cap }),
      });
      return fromResponse(
        res,
        `model ${model} answered on ${provider} (${base})`,
        `${provider} (${base})`
      );
    },
  },
  {
    name: "perplexity",
    required: false,
    keys: ["PERPLEXITY_API_KEY"],
    async check() {
      const res = await get("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("PERPLEXITY_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env("PERPLEXITY_MODEL") || "sonar",
          messages: [{ role: "user", content: "hi" }],
          // Perplexity rejects max_tokens below 16 with a 400, so a 1-token
          // probe reported FAIL for a working credential — the misleading-script
          // failure this check exists to prevent.
          //
          // ORDERING, measured rather than assumed: Perplexity AUTHENTICATES
          // FIRST. A bogus key with max_tokens 1 returns 401, not 400. So a 400
          // here actually proves the key is good — the opposite of what an
          // earlier version of this comment claimed. Corrected because a
          // liveness check that misinforms about its own failure modes is the
          // same defect it exists to catch.
          max_tokens: 16,
        }),
      });
      return fromResponse(res, "16-token completion");
    },
  },
  {
    name: "firecrawl",
    required: false,
    keys: ["FIRECRAWL_API_KEY"],
    async check() {
      const res = await get("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("FIRECRAWL_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com", formats: ["markdown"], onlyMainContent: true }),
      });
      return fromResponse(res, "scraped example.com");
    },
  },
  {
    name: "openai",
    required: false,
    keys: ["OPENAI_API_KEY"],
    async check() {
      const res = await get("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
      });
      return fromResponse(res, "model list");
    },
  },
  {
    name: "gemini",
    required: false,
    keys: ["GEMINI_API_KEY"],
    async check() {
      const res = await get(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(env("GEMINI_API_KEY"))}`
      );
      return fromResponse(res, "model list");
    },
  },
  {
    name: "gsc",
    required: false,
    keys: ["GSC_SERVICE_ACCOUNT_KEY"],
    // This check WAS offline-only, justified by a comment claiming that signing
    // the JWT "would pull in a dependency this script deliberately does not
    // have". That was false: src/lib/engines/gsc.js imports nothing but node's
    // own `crypto`, signs the assertion with crypto.createSign at :78, and
    // already exposes listGscSites() — the cheapest authenticated read Search
    // Console offers. The dependency was imaginary and the gap was avoidable.
    //
    // Shape is still validated first, because a malformed key should say so
    // rather than surface as an opaque auth failure. But a valid shape is no
    // longer reported as a pass on its own: that was a PASS for a check that
    // never ran, which is the exact lie this script exists to prevent.
    async check() {
      const raw = env("GSC_SERVICE_ACCOUNT_KEY");
      let json;
      try {
        json = JSON.parse(/^\s*\{/.test(raw) ? raw : Buffer.from(raw, "base64").toString("utf8"));
      } catch {
        return { verdict: FAIL, detail: "not valid JSON, and not valid base64-encoded JSON" };
      }
      const missing = ["client_email", "private_key", "type"].filter((k) => !json[k]);
      if (missing.length) return { verdict: FAIL, detail: `service account is missing ${missing.join(", ")}` };

      try {
        const { listGscSites } = await import("../src/lib/engines/gsc.js");
        const sites = await listGscSites();
        return {
          verdict: PASS,
          detail:
            `${json.client_email} authenticated; ${sites.length} Search Console ` +
            `propert${sites.length === 1 ? "y" : "ies"} readable` +
            (sites.length === 0
              ? " — the key works but is not yet a user on any property, so every GSC read will come back empty"
              : ""),
        };
      } catch (err) {
        // Distinguish a LOCAL signing failure from an API refusal. A malformed
        // private key never reaches Google — it dies in crypto.createSign — and
        // reporting that as "the API refused it" would send the operator to
        // check Search Console permissions for a problem in their own file.
        const msg = String(err.message || err);
        const localSigningFailure = /DECODER|PEM|no start line|unsupported|asn1/i.test(msg);
        return {
          verdict: FAIL,
          detail: localSigningFailure
            ? `shape valid for ${json.client_email}, but its private_key could not be used to sign — the key itself is malformed, nothing was sent: ${msg.slice(0, 100)}`
            : `shape valid for ${json.client_email}, but the API refused it: ${msg.slice(0, 140)}`,
        };
      }
    },
  },
  {
    name: "cron",
    required: true,
    keys: ["CRON_SECRET"],
    // Nothing to call: this secret guards our own routes. Its presence IS the
    // check, and its absence is what makes both worker routes fail closed in
    // production (src/lib/cronAuth.js).
    async check() {
      const secret = env("CRON_SECRET");
      if (secret.length < 16) {
        return { verdict: FAIL, detail: `only ${secret.length} chars — use a long random string` };
      }
      return { verdict: PASS, detail: "set (local check only — no call to make)" };
    },
  },
];

/**
 * The one NON-VENDOR check in this script, reported under its own heading.
 *
 * R2.10.1 (finding C11, second pass). It closes two holes at once:
 *
 *   1. engineDriftWarning() had NO production caller. It was written for
 *      exactly this failure and .env.example told operators it "reports a
 *      mismatch", but the only thing that ever invoked it was a unit test. A
 *      guard documented as live that runs only in its own test is the same
 *      shape of claim as a "Live" chip on a hardcoded script.
 *
 *   2. deployedEngines() — which drives the hero sentence, the engine rail and
 *      the sample report — cannot consult isConfigured(). It is bundled into a
 *      client component, so it must never read OPENAI_API_KEY, and in the
 *      browser the value would be undefined anyway. So
 *      ENGINES=aio,chatgpt,perplexity with no OPENAI_API_KEY makes the page
 *      advertise ChatGPT while resolveEnabledEngines (enginePipeline.js:527)
 *      skips it behind a console.warn nobody reads: every scan measures two
 *      engines and every visitor is told three. Only a server-side check sees
 *      both halves. This is that check.
 *
 * It is deliberately NOT a row in VENDORS. That table is a credential table
 * and checkSecrets.test.mjs asserts it stays name-for-name identical to
 * /api/health's; "engines" is not a credential, and it has an answer even on a
 * deployment holding none. Hence its own heading, its own vocabulary, and no
 * PASS/FAIL/UNCONFIGURED token to be miscounted as a vendor verdict.
 *
 * The key map MIRRORS ENGINE_REGISTRY.isConfigured deliberately. aio has no key
 * of its own there (it probes through Bright Data, which IS a vendor row), so
 * inventing one here would fail deployments the fleet would happily run.
 */
const ENGINE_API_KEY = { aio: null, chatgpt: "OPENAI_API_KEY", perplexity: "PERPLEXITY_API_KEY" };

/** resolveEnabledEngines' own fallback when ENGINES is unset (enginePipeline.js). */
const FLEET_DEFAULT = "aio";

function checkEngineAdvertising() {
  const label = (names) => formatEngineList(names.map((n) => ENGINE_LABELS[n]));
  const drift = engineDriftWarning(process.env);
  if (drift) return { ok: false, line: `MISMATCH: ${drift}` };

  // engineDriftWarning returns null when only ONE of the pair is set, because
  // it compares two lists and here there is only one. That is still the two
  // variables out of step, and it has a worse symptom than a wrong label:
  // ENGINES is server-only, so SSR renders the real list and the browser
  // renders the "aio" default (deployedEngines.js, the fallback path). Same
  // page, two answers, plus a React hydration mismatch.
  const pub = parseEngineList(process.env.NEXT_PUBLIC_ENGINES);
  const srv = parseEngineList(process.env.ENGINES);

  if (srv.length && !pub.length) {
    return {
      ok: false,
      line:
        `MISMATCH: ENGINES=${srv.join(",")} is set but NEXT_PUBLIC_ENGINES is not. ENGINES is ` +
        `server-only, so the server would render ${label(srv)} and the browser the aio default. ` +
        `Set NEXT_PUBLIC_ENGINES to the same list.`,
    };
  }

  // The mirror image, and the one that flatters: the page reads
  // NEXT_PUBLIC_ENGINES first, so it names whatever is there, while the fleet
  // falls back to resolveEnabledEngines' own "aio" default. Every visitor is
  // told about engines no scan ever runs.
  if (pub.length && !srv.length && pub.join(",") !== FLEET_DEFAULT) {
    return {
      ok: false,
      line:
        `MISMATCH: NEXT_PUBLIC_ENGINES=${pub.join(",")} is set but ENGINES is not, so the page ` +
        `advertises ${label(pub)} while the fleet falls back to its ${FLEET_DEFAULT} default and ` +
        `probes ${label(parseEngineList(FLEET_DEFAULT))}. Set ENGINES to the same list.`,
    };
  }

  const advertised = deployedEngines(process.env);
  const unfunded = advertised.filter((n) => ENGINE_API_KEY[n] && !env(ENGINE_API_KEY[n]));
  if (unfunded.length) {
    const one = unfunded.length === 1;
    return {
      ok: false,
      line:
        `MISMATCH: the page advertises ${label(unfunded)}, but ` +
        `${unfunded.map((n) => ENGINE_API_KEY[n]).join(", ")} ${one ? "is" : "are"} not set, so ` +
        `resolveEnabledEngines skips ${one ? "it" : "them"} on every scan. Set the key, or drop ` +
        `${one ? "it" : "them"} from ENGINES and NEXT_PUBLIC_ENGINES.`,
    };
  }

  const from = env("NEXT_PUBLIC_ENGINES")
    ? "NEXT_PUBLIC_ENGINES"
    : env("ENGINES")
      ? "ENGINES"
      : "the aio default";
  return {
    ok: true,
    line: `in step: the page advertises ${label(advertised)} (from ${from}), and the fleet can probe every one`,
  };
}

const MARK = { [PASS]: "  ok  ", [FAIL]: " FAIL ", [UNCONFIGURED]: " ---- " };

async function main() {
  const results = [];

  for (const vendor of VENDORS) {
    const missing = vendor.keys.filter((k) => !env(k));
    // Either/or credentials: none of the accepted names set means the vendor is
    // UNCONFIGURED, reported under its canonical name.
    if (vendor.anyKeys?.length && !vendor.anyKeys.some((k) => env(k))) missing.push(vendor.anyKeys[0]);
    if (missing.length) {
      results.push({
        name: vendor.name,
        verdict: UNCONFIGURED,
        detail: `missing ${missing.join(", ")}`,
        required: vendor.required,
      });
      continue;
    }
    let outcome;
    try {
      outcome = await vendor.check();
    } catch (err) {
      // A thrown error is a FAIL, never a skip. An unreachable vendor is not
      // a working one.
      outcome = { verdict: FAIL, detail: err.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS}ms` : err.message };
    }
    results.push({ name: vendor.name, ...outcome, required: vendor.required });
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const req = r.required ? "required" : "optional";
    console.log(`[${MARK[r.verdict]}] ${r.name.padEnd(width)}  ${r.verdict.padEnd(12)} ${req.padEnd(8)}  ${r.detail || ""}`);
  }

  const failures = results.filter((r) => r.verdict === FAIL);
  const unconfiguredRequired = results.filter((r) => r.verdict === UNCONFIGURED && r.required);

  console.log("");
  console.log(
    `${results.filter((r) => r.verdict === PASS).length} pass · ${failures.length} fail · ` +
      `${results.filter((r) => r.verdict === UNCONFIGURED).length} unconfigured ` +
      `(${unconfiguredRequired.length} of them required)`
  );
  if (unconfiguredRequired.length) {
    console.log(
      `note: ${unconfiguredRequired.map((r) => r.name).join(", ")} ${
        unconfiguredRequired.length === 1 ? "is" : "are"
      } required for a scan to run. Unconfigured is not a failure here — it is ` +
        `a deployment that cannot scan.`
    );
  }

  // Not a vendor, not a credential, and printed outside the table above so it
  // cannot be parsed as one. It always has an answer, including on a machine
  // holding no credentials at all — which is the point: the page advertises
  // engines whether or not anything is configured.
  const engines = checkEngineAdvertising();
  console.log("");
  console.log("engine advertising — what the landing page names vs what the fleet can probe:");
  console.log(`  ${engines.line}`);

  // The contract: non-zero when a CONFIGURED vendor failed, or when the page
  // and the fleet disagree about what this deployment measures.
  process.exit(failures.length || !engines.ok ? 1 : 0);
}

// Run only when invoked as a script. checkSecrets.test.mjs still executes the
// real file as a subprocess (so the CLI contract stays under test), while
// checkSecretsBrightdata.test.mjs imports VENDORS to drive one check() against a
// mocked fetch — which an unconditional main() would have made impossible.
const isEntry =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntry) {
  main().catch((err) => {
    console.error(`check:secrets crashed: ${err.stack || err}`);
    process.exit(2);
  });
}
