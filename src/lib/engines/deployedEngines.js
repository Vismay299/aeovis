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
 */

/** Registry name -> the label a human should see. */
export const ENGINE_LABELS = Object.freeze({
  aio: "Google AI Overview",
  chatgpt: "ChatGPT",
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
