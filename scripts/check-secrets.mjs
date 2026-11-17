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
 * That is the ONLY difference between the two surfaces, and since R0.1.16 it is
 * the only thing this file decides. WHICH vendors exist comes from the one
 * registry /api/health also reads (src/server/vendorRegistry.js). This script used
 * to keep a second nine-vendor array of its own; the lists happened to agree, so
 * nothing caught that they were independent, and a tenth vendor added to either
 * would have been reported by one surface and silently missing from the other.
 *
 * Rules this script follows, because it exists to tell the truth about state:
 *   - Exactly three verdicts. UNCONFIGURED (no credential) is NOT a pass and
 *     NOT a failure; it is a third thing, and it must look different from both.
 *   - Exit code is non-zero only when a CONFIGURED vendor fails, or when the
 *     engine-advertising check below finds the landing page naming an engine
 *     the fleet will skip (R2.10.1). An unconfigured optional vendor must not
 *     break a deploy gate; a page that lies about coverage should. (The one
 *     other way to exit non-zero is refusing to start at all — see
 *     vendorsWithChecks — and that prints no table, so it cannot be mistaken
 *     for a verdict.)
 *   - Every call is the cheapest practical read the vendor offers, with a hard
 *     timeout. The shared Perplexity model path needs a 16-token output cap; it
 *     returns one short word, but a smaller cap is rejected by that API path.
 *
 * Usage:
 *   npm run check:secrets              # reads .env.local
 *   node scripts/check-secrets.mjs     # reads the ambient environment
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getLlmApiKey, getLlmBaseUrl, getLlmModel, getLlmProvider } from "../src/shared/llmConfig.js";
// R0.1.16 (finding S30) — the vendor list is NOT this script's. It is the one
// registry /api/health also reads, so a vendor cannot exist on one surface and
// not the other. This file contributes the half that is genuinely its own: the
// live authenticated call per vendor, in VENDOR_CHECKS below.
import { VENDORS as VENDOR_REGISTRY, credentialStatus } from "../src/server/vendorRegistry.js";
// R0.1.10 — the client's OWN zone resolver, so this check is on the same code
// path every probe uses rather than a mirror of it.
import { resolveBrightDataSerpZone } from "../src/shared/engines/brightdata.js";
import { getOpenRouterEngineModel, isOpenRouterEngineConfigured } from "../src/shared/engines/openRouterProbe.js";
import {
  ENGINE_LABELS,
  deployedEngines,
  engineDriftWarning,
  formatEngineList,
  parseEngineList,
} from "../src/shared/engines/deployedEngines.js";
import { routeOrder, isRouteConfigured } from "../src/shared/engines/engineRoutes.ts";
import { fetchUserData } from "../src/shared/providers/dataforseo/appendix.ts";

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

/** Validate an answer engine using the same OpenRouter key, base URL and model selection as scans. */
async function checkOpenRouterModel(engine) {
  const base = getLlmBaseUrl();
  const model = getOpenRouterEngineModel(engine);
  if (!isOpenRouterEngineConfigured(engine)) {
    return {
      verdict: FAIL,
      detail: `engine ${engine} needs the shared LLM_API_KEY and OpenRouter gateway (${base})`,
    };
  }
  const res = await get(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getLlmApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with one word: ready" }],
      max_tokens: 16,
    }),
  });
  return fromResponse(res, `model ${model} answered through OpenRouter`, `OpenRouter (${base})`);
}

/**
 * The LIVE half, one function per vendor KEY in the registry.
 *
 * This object is deliberately not a vendor table. Which env vars a vendor needs,
 * which of its names are deprecated, and whether a scan can run without it are
 * facts about the vendor and live once, in src/server/vendorRegistry.js, where
 * /api/health reads them too. What belongs HERE is the one thing /api/health can
 * never do: spend a request proving the credential actually works.
 *
 * A key missing from this object is not a vendor that quietly gets no check —
 * vendorsWithChecks() below refuses to run and names it.
 */
export const VENDOR_CHECKS = {
  // PostgREST select-1: no rows returned, cheapest possible round trip.
  async supabase() {
    const res = await get(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/scans?select=id&limit=1`, {
      headers: {
        apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
        Authorization: `Bearer ${env("NEXT_PUBLIC_SUPABASE_ANON_KEY")}`,
      },
    });
    return fromResponse(res, "select 1 from scans");
  },

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
  // this check is on it. It throws on a no-active-zone account, and the LOCAL
  // try/catch around the call below is what converts that throw into a FAIL
  // carrying the resolver's own reason plus the consequence. An earlier version
  // of this comment credited "main()'s catch", which is wrong twice over: the
  // local catch runs first, main()'s per-vendor catch would give only a bare
  // err.message, and main()'s outer catch exits 2 as a crash. Exercised, not
  // assumed — src/server/checkSecretsBrightdataNoZone.test.mjs drives this branch.
  //
  // The env read and the type/status filter below are still here on purpose and
  // are NOT a second copy of the resolver: they only pick the PASS wording and
  // the zone count/list in the failure detail. Neither one chooses the zone
  // that gets validated. The `zone` variable comes from the resolver, nowhere else.
  async brightdata() {
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
    // variable is documented as optional. But the operator should know the name
    // was picked FOR them, and for how long it will be reused before anything
    // re-checks it.
    //
    // THAT REUSE IS NOW BOUNDED (R1.2.7). This comment and the detail below used
    // to say "for the life of the process". That was a true reading of the old
    // bare-string cache; against the shipped code it is overstated three ways.
    // The cache entry carries a timestamp and expires after
    // BRIGHTDATA_ZONE_TTL_MS, default five minutes
    // (DEFAULT_BRIGHTDATA_ZONE_TTL_MS, brightdata.js:72). A probe Bright Data
    // refuses drops the entry on the spot (brightdata.js:313-327), so recovery
    // is one failed probe rather than one TTL. And invalidateBrightDataZoneCache()
    // (brightdata.js:116-124) can force a re-check at any time. The window in
    // which THIS process can report the truth while a probing process acts on a
    // stale name is therefore one TTL, not one process lifetime.
    //
    // The detail names the VARIABLE rather than the resolved number on purpose.
    // Reading the number would mean calling brightDataZoneTtlMs() here, outside
    // this entry's local try/catch, and that function throws on a malformed
    // value; main()'s per-vendor catch would then report a TTL typo as a bare
    // err.message on the brightdata row, losing "Every AIO probe will fail."
    return {
      verdict: PASS,
      detail:
        `${serp.length} active serp zone(s); no BRIGHTDATA_SERP_ZONE set, so probes ` +
        `AUTO-DISCOVERED "${zone}" and will cache it for BRIGHTDATA_ZONE_TTL_MS ` +
        `(default 5 min) before re-checking it`,
    };
  },

  // Which NAME configures this vendor — LLM_API_KEY canonical, OPENROUTER_API_KEY
  // a still-accepted deprecated alias (R5.1.1) — is a registry fact and is stated
  // there, once. By the time this runs the credential is present under one of them
  // and getLlmApiKey() picks whichever.
  //
  // One token against the configured model. Also proves the MODEL is valid
  // on this gateway, which a key check alone does not: a model id valid on
  // one OpenAI-compatible gateway is routinely invalid on another.
  async llm() {
    const base = getLlmBaseUrl(process.env);
    const model = getLlmModel(process.env);
    const provider = getLlmProvider(base);
    // Mirror the client's per-gateway request shape (src/server/openrouter.js):
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

  async perplexity() {
    return checkOpenRouterModel("perplexity");
  },

  async firecrawl() {
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

  async openai() {
    return checkOpenRouterModel("chatgpt");
  },

  async gemini() {
    return checkOpenRouterModel("gemini");
  },

  // This check WAS offline-only, justified by a comment claiming that signing
  // the JWT "would pull in a dependency this script deliberately does not
  // have". That was false: src/shared/engines/gsc.js imports nothing but node's
  // own `crypto`, signs the assertion with crypto.createSign at :78, and
  // already exposes listGscSites() — the cheapest authenticated read Search
  // Console offers. The dependency was imaginary and the gap was avoidable.
  //
  // Shape is still validated first, because a malformed key should say so
  // rather than surface as an opaque auth failure. But a valid shape is no
  // longer reported as a pass on its own: that was a PASS for a check that
  // never ran, which is the exact lie this script exists to prevent.
  async gsc() {
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
      const { listGscSites } = await import("../src/shared/engines/gsc.js");
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

  // Nothing to call: this secret guards our own routes. Its presence IS the
  // check, and its absence is what makes both worker routes fail closed in
  // production (src/server/cronAuth.js).
  async cron() {
    const secret = env("CRON_SECRET");
    if (secret.length < 16) {
      return { verdict: FAIL, detail: `only ${secret.length} chars — use a long random string` };
    }
    return { verdict: PASS, detail: "set (local check only — no call to make)" };
  },

  // GSC OAuth connector — the self-service customer path. Only checks that
  // the env vars are present and the encryption key is valid; the actual
  // Google authorization happens per-workspace at runtime.
  async gsc_oauth() {
    const clientId = env("GSC_GOOGLE_CLIENT_ID");
    const clientSecret = env("GSC_GOOGLE_CLIENT_SECRET");
    const redirectUri = env("GSC_OAUTH_REDIRECT_URI");
    const encKey = env("GSC_TOKEN_ENCRYPTION_KEY");

    if (!clientId || !clientSecret || !redirectUri) {
      const missing = [];
      if (!clientId) missing.push("GSC_GOOGLE_CLIENT_ID");
      if (!clientSecret) missing.push("GSC_GOOGLE_CLIENT_SECRET");
      if (!redirectUri) missing.push("GSC_OAUTH_REDIRECT_URI");
      return { verdict: UNCONFIGURED, detail: `missing: ${missing.join(", ")}` };
    }

    if (!encKey || encKey.length !== 64) {
      return { verdict: FAIL, detail: "GSC_TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)" };
    }

    try {
      Buffer.from(encKey, "hex");
    } catch {
      return { verdict: FAIL, detail: "GSC_TOKEN_ENCRYPTION_KEY is not valid hex" };
    }

    return { verdict: PASS, detail: `client ID ${clientId.slice(0, 12)}…, redirect ${redirectUri}, encryption key set` };
  },

  async dataforseo() {
    try {
      await fetchUserData({ env: process.env });
      return { verdict: PASS, detail: "user_data answered" };
    } catch {
      return { verdict: FAIL, detail: "DataForSEO request failed" };
    }
  },
};

/**
 * Join the shared registry to this script's live checks — and REFUSE if they
 * disagree (R0.1.16, finding S30).
 *
 * This is the guard that makes one list stay one list. A registry vendor with no
 * function above would otherwise be a vendor this script simply never mentions:
 * /api/health would report it, `check:secrets` would print a table without it,
 * and the operator would read a clean run as coverage it never had. A skip is
 * not a success, so there is no skip.
 *
 * It throws at MODULE SCOPE, from the `VENDORS` initialiser below, so it fires
 * before main() exists and no table is ever printed. Node reports the message
 * and stack on stderr and exits 1 — measured, not assumed. Note that is exit 1
 * without a report, not the entry-point catch's exit 2: an import-time throw
 * never reaches that handler. A reader cannot tell this from "a configured
 * vendor failed" by exit code alone, but they cannot miss it either, because
 * there is no verdict table above it.
 *
 * The mirror-image error is caught too: a check for a key the registry does not
 * carry is a vendor half-added, and running it would report on a vendor
 * /api/health does not know exists.
 *
 * Both arguments are injectable so the failure paths are exercised rather than
 * asserted — src/server/vendorRegistry.test.mjs drives them.
 */
export function vendorsWithChecks(registry = VENDOR_REGISTRY, checks = VENDOR_CHECKS) {
  const keys = registry.map((v) => v.key);
  const uncheckedVendors = keys.filter((k) => typeof checks[k] !== "function");
  const orphanedChecks = Object.keys(checks).filter((k) => !keys.includes(k));

  if (uncheckedVendors.length || orphanedChecks.length) {
    const parts = [];
    if (uncheckedVendors.length) {
      parts.push(
        `${uncheckedVendors.join(", ")} ${uncheckedVendors.length === 1 ? "is" : "are"} in the vendor ` +
          `registry (src/server/vendorRegistry.js) with no live check in VENDOR_CHECKS, so check:secrets ` +
          `would silently omit ${uncheckedVendors.length === 1 ? "it" : "them"} while /api/health reports ` +
          `${uncheckedVendors.length === 1 ? "it" : "them"}`
      );
    }
    if (orphanedChecks.length) {
      parts.push(
        `VENDOR_CHECKS has ${orphanedChecks.join(", ")}, which no registry vendor claims, so this script ` +
          `would report on ${orphanedChecks.length === 1 ? "a vendor" : "vendors"} /api/health does not know about`
      );
    }
    throw new Error(`check:secrets and /api/health have drifted apart: ${parts.join("; ")}`);
  }

  // `key` stays the one name for a vendor — the registry's. No `name` alias:
  // two spellings for the same field is how two lists start.
  return registry.map((vendor) => ({ ...vendor, check: checks[vendor.key] }));
}

/**
 * The vendor rows this script runs: registry facts plus this file's live check.
 * Exported so the per-vendor tests can drive one check() against a mocked fetch
 * without the CLI running.
 */
export const VENDORS = vendorsWithChecks();

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
 *      ENGINES=aio,chatgpt,perplexity with no shared OpenRouter key makes the
 *      page advertise engines while resolveEnabledEngines skips them. Only a
 *      server-side check sees both halves. This is that check.
 *
 * It is deliberately NOT a row in VENDORS. That table is a credential table and
 * it now literally IS /api/health's — both read src/server/vendorRegistry.js — so a
 * row added here is a credential /api/health will report as configured or
 * missing. "engines" is not a credential, and it has an answer even on a
 * deployment holding none. Hence its own heading, its own vocabulary, and no
 * PASS/FAIL/UNCONFIGURED token to be miscounted as a vendor verdict.
 *
 * The key map MIRRORS ENGINE_REGISTRY.isConfigured deliberately. aio has no key
 * of its own there (it probes through Bright Data, which IS a vendor row), so
 * inventing one here would fail deployments the fleet would happily run.
 */
const OPENROUTER_ENGINES = new Set(["chatgpt", "gemini", "perplexity"]);

/** resolveEnabledEngines' own fallback when ENGINES is unset (enginePipeline.js). */
const FLEET_DEFAULT = "aio";

export function checkRouteFunding(engine, env = process.env) {
  const routes = routeOrder(engine, env);
  return routes.some((r) => isRouteConfigured(engine, r, env));
}

export function checkEngineAdvertising(env = process.env) {
  const label = (names) => formatEngineList(names.map((n) => ENGINE_LABELS[n] || n));
  const drift =
    env === process.env
      ? engineDriftWarning(process.env)
      : engineDriftWarning(env);
  if (drift) return { ok: false, line: `MISMATCH: ${drift}` };

  // engineDriftWarning returns null when only ONE of the pair is set, because
  // it compares two lists and here there is only one. That is still the two
  // variables out of step, and it has a worse symptom than a wrong label:
  // ENGINES is server-only, so SSR renders the real list and the browser
  // renders the "aio" default (deployedEngines.js, the fallback path). Same
  // page, two answers, plus a React hydration mismatch.
  const pub = parseEngineList(env.NEXT_PUBLIC_ENGINES);
  const srv = parseEngineList(env.ENGINES);

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

  const advertised = deployedEngines(env);
  const unfunded = advertised.filter((name) => {
    // aio probing through Bright Data is governed by the brightdata vendor check
    // row (required). Treating an unconfigured Bright Data credential as an
    // advertising mismatch would cause `check:secrets` to exit 1 on clean deployments
    // holding no credentials, violating "UNCONFIGURED is not a failure: exit 0".
    if (name === "aio" && routeOrder(name, env).includes("brightdata")) {
      return false;
    }
    return !checkRouteFunding(name, env);
  });
  if (unfunded.length) {
    const one = unfunded.length === 1;
    const routesStr = unfunded.map((name) => routeOrder(name, env).join(">")).join(", ");
    return {
      ok: false,
      line:
        `MISMATCH: the page advertises ${label(unfunded)}, but ` +
        `no answer route for ${one ? "it" : "them"} is configured (routes: ${routesStr}). ` +
        `Configure one, or drop ${one ? "it" : "them"} from ENGINES and NEXT_PUBLIC_ENGINES.`,
    };
  }

  const from = env.NEXT_PUBLIC_ENGINES
    ? "NEXT_PUBLIC_ENGINES"
    : env.ENGINES
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
    // The SAME function /api/health calls (vendorRegistry.credentialStatus), so
    // the two surfaces cannot disagree about what "configured" means. A vendor
    // whose credential is absent is UNCONFIGURED under its canonical name and
    // `check` is never called — deprecated aliases count as present.
    const { configured, missing } = credentialStatus(vendor, process.env);
    if (!configured) {
      results.push({
        name: vendor.key,
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
    results.push({ name: vendor.key, ...outcome, required: vendor.required });
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
