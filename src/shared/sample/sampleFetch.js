/**
 * The browser half of sample mode: window.fetch answers the portal's API
 * requests from fixtures instead of the network.
 *
 * - GET/HEAD to a portal API path is answered from src/shared/sample/fixtures.
 *   A path with no fixture answers 404 with a plain message, never the server.
 * - Any write (POST/PUT/PATCH/DELETE) to a portal API path answers 403 with a
 *   "sample workspace" message, so a button that would save, spend or send
 *   shows why it did nothing.
 * - Anything to Supabase answers `null`: the sample workspace has no session
 *   and must never reach the auth or database API.
 * - Everything else (static assets, the public scan form) goes to the network.
 *
 * The server refuses the same API paths while the sample cookie is set
 * (src/server/sampleGuard.js), so a request that slipped past this layer
 * still could not read or change real data.
 */
import { isSampleApiPath } from "./mode.js";

export const SAMPLE_WRITE_MESSAGE =
  "This is the sample workspace, so nothing is saved or run. Sign up to do this for your own brand.";

function json(body, status = 200) {
  if (status === 204) return new Response(null, { status, headers: { "x-perceev-sample": "1" } });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-perceev-sample": "1" },
  });
}

function requestMethod(input, init) {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function requestUrl(input) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  return new URL(raw, window.location.href);
}

let fixturesPromise = null;
function loadFixtures() {
  fixturesPromise ??= import("./fixtures/index.js");
  return fixturesPromise;
}

/** Answers one request the way the sample workspace does, or null to pass it on. */
export async function sampleAnswer(input, init) {
  const url = requestUrl(input);
  if (url.hostname.endsWith(".supabase.co")) return json(null);
  if (url.origin !== window.location.origin || !isSampleApiPath(url.pathname)) return null;

  const method = requestMethod(input, init);
  const { sampleResponse } = await loadFixtures();
  if (method !== "GET" && method !== "HEAD") {
    // A few POSTs are reads (a keyword lookup, a price quote). Those have
    // sample answers; every other write is refused with an explanation.
    let body = null;
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch { body = null; }
    const read = sampleResponse(url, method, body);
    if (read) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return json(read.body, read.status ?? 200);
    }
    return json({ error: SAMPLE_WRITE_MESSAGE, code: "sample_workspace", sample: true }, 403);
  }
  const answer = sampleResponse(url, "GET", null);
  if (!answer) {
    if (process.env.NODE_ENV !== "production") console.warn(`[sample] no fixture for GET ${url.pathname}${url.search}`);
    return json({ error: "The sample workspace has no data for this view.", sample: true }, 404);
  }
  // A short, steady delay so loading states behave as they do on real data.
  await new Promise((resolve) => setTimeout(resolve, 120));
  return json(answer.body, answer.status ?? 200);
}

/** Installs the sample layer once. Safe to call during render. */
export function installSampleFetch() {
  if (typeof window === "undefined" || window.__perceevSampleFetch) return;
  const network = window.fetch.bind(window);
  window.__perceevSampleFetch = true;
  window.fetch = async (input, init) => (await sampleAnswer(input, init)) ?? network(input, init);
  // EventSource streams (assistant) have no sample transport: refuse them plainly.
  if (typeof window.EventSource === "function") {
    const NativeEventSource = window.EventSource;
    window.EventSource = function SampleEventSource(url, config) {
      const target = new URL(url, window.location.href);
      if (target.origin === window.location.origin && isSampleApiPath(target.pathname)) {
        throw new Error(SAMPLE_WRITE_MESSAGE);
      }
      return new NativeEventSource(url, config);
    };
  }
}
