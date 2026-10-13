/**
 * Which engines this deployment actually probes — one source of truth for
 * anything user-facing that names them.
 *
 * R2.10.1. The landing page claimed "Google AI Overview, ChatGPT and
 * Perplexity" as a hardcoded sentence while the deployment ran
 * `ENGINES=aio,perplexity` and had no OPENAI_API_KEY at all, so ChatGPT could
 * not have run even if it had been listed. A marketing claim about coverage is
 * a claim about the product, and it was wrong in the direction that flatters.
 *
 * `ENGINES` is server-only, so it is not visible to a client component;
 * `NEXT_PUBLIC_ENGINES` is the client-readable mirror. They are two variables
 * and can therefore drift, which is why `engineDriftWarning()` exists and why a
 * guard test asserts the landing page names nothing outside this list.
 *
 * The default matches resolveEnabledEngines' own default ("aio") deliberately:
 * an unconfigured deployment should under-claim, never over-claim.
 *
 * WHAT THIS FILE CANNOT DO, and where that is covered.
 *
 * resolveEnabledEngines (src/lib/scoring/enginePipeline.js:resolveEnabledEngines) additionally
 * drops any engine whose isConfigured() is false. This module CANNOT: it is
 * bundled into a client component, so it must never read OPENAI_API_KEY or
 * PERPLEXITY_API_KEY, and if it tried, the value would be undefined in the
 * browser anyway. So ENGINES=aio,chatgpt,perplexity with no OPENAI_API_KEY
 * makes the page advertise an engine the fleet skips — the original C11 bug,
 * still reachable by config and harmless today only because ENGINES excludes
 * chatgpt. That gap is closed at deploy time, on the server, where both halves
 * are visible: the "engine advertising" section of scripts/check-secrets.mjs
 * FAILS the run on it, and on ENGINES/NEXT_PUBLIC_ENGINES drift in either
 * direction — including the one-sided case below.
 */

/** Registry name -> the label a human should see. */
export const ENGINE_LABELS = Object.freeze({
  aio: "Google AI Overview",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  perplexity: "Perplexity",
});

const DEFAULT_ENGINES = "aio";

/**
 * Captured as a LITERAL `process.env.NEXT_PUBLIC_*` expression on purpose.
 *
 * Next inlines NEXT_PUBLIC_ vars into the browser bundle by statically
 * replacing that exact expression at build time. Reading it dynamically —
 * `env.NEXT_PUBLIC_ENGINES` off a variable — cannot be replaced, so the value
 * is present during SSR and `undefined` in the browser. The first version of
 * this file did exactly that: the server rendered "Google AI Overview and
 * Perplexity" and the client rendered "Google AI Overview", which is a
 * hydration mismatch AND still an inaccurate claim, half the time.
 */
const INLINED_PUBLIC_ENGINES = process.env.NEXT_PUBLIC_ENGINES;

/** Parse an ENGINES-style comma list into known registry names. */
export function parseEngineList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && Object.prototype.hasOwnProperty.call(ENGINE_LABELS, s));
}

/**
 * The engines this deployment probes, as registry names.
 *
 * Reads NEXT_PUBLIC_ENGINES first so a client component sees the real list,
 * then ENGINES for server callers, then the same default the pipeline uses.
 */
export function deployedEngines(env = null) {
  // With no explicit env (the app's own call), read the INLINED literal so the
  // browser bundle carries the real value. Tests pass an env object and get
  // pure behaviour with no bundler involvement.
  const publicRaw = env ? env.NEXT_PUBLIC_ENGINES : INLINED_PUBLIC_ENGINES;
  // `ENGINES` is server-only, so in the browser this expression is NOT inlined
  // and evaluates to undefined. On this fallback path SSR renders the server's
  // ENGINES list and the client renders the "aio" default: one page, two
  // answers, and a React hydration mismatch. The direction is an under-claim,
  // so it is not urgent, and it cannot be fixed here — a client bundle has no
  // way to read a server-only variable. It is instead made UNREACHABLE at
  // deploy time: check:secrets FAILS when ENGINES is set and
  // NEXT_PUBLIC_ENGINES is not, which is the only way to arrive here.
  const serverRaw = env ? env.ENGINES : process.env.ENGINES;

  const fromPublic = parseEngineList(publicRaw);
  if (fromPublic.length) return fromPublic;
  const fromServer = parseEngineList(serverRaw);
  if (fromServer.length) return fromServer;
  return parseEngineList(DEFAULT_ENGINES);
}

/** The same list, as labels, for rendering. */
export function deployedEngineLabels(env = null) {
  return deployedEngines(env).map((name) => ENGINE_LABELS[name]);
}

/**
 * The one engine to name where a surface can only carry a single name.
 *
 * R2.10.5. The hero's answer sheet shows ONE answer, so its chip names one
 * engine. It used to name "Perplexity" as a typed literal: rebuilt under
 * NEXT_PUBLIC_ENGINES=aio the hero sentence and the engine rail both correctly
 * narrowed to Google AI Overview while that chip went on naming an engine the
 * deployment does not probe. First rather than any-of, so the choice is
 * deterministic and SSR and the client cannot pick differently.
 */
export function primaryDeployedEngineLabel(env = null) {
  const [label] = deployedEngineLabels(env);
  if (!label) {
    // Unreachable while DEFAULT_ENGINES parses to at least one engine, which is
    // what deployedEngines() falls back to. If that ever stops being true, an
    // empty chip beside a written-out answer still READS as an attribution, so
    // it fails here instead.
    throw new Error(
      'deployedEngines: no engine to name, so a surface that must attribute an '
      + 'answer to one would render an empty attribution.',
    );
  }
  return label;
}

/** "A, B and C" — for prose that names the engines. */
export function formatEngineList(labels) {
  if (labels.length === 0) return "no answer engines";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Non-null when the two variables disagree, so a deployment that updates one
 * and forgets the other is loud rather than quietly mis-advertising.
 */
export function engineDriftWarning(env = process.env) {
  const pub = parseEngineList(env.NEXT_PUBLIC_ENGINES);
  const srv = parseEngineList(env.ENGINES);
  if (!pub.length || !srv.length) return null;
  const a = [...pub].sort().join(",");
  const b = [...srv].sort().join(",");
  if (a === b) return null;
  return (
    `NEXT_PUBLIC_ENGINES (${a}) does not match ENGINES (${b}). The marketing copy ` +
    `and the probe fleet disagree about what this deployment measures.`
  );
}
