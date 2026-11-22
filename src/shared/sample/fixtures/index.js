/**
 * Fixtures for the sample workspace (see ../mode.js). Every answer describes
 * Brightwave, a fictional EHR platform, and its fictional rivals. Nothing here
 * is a measurement; the sample banner says so on every page.
 *
 * `sampleResponse(url, method, body)` returns `{ body, status? }` for a request
 * the portal makes, or null when the sample has no answer for it. Routes are
 * GET unless they name a method; a POST route is a read with a request body
 * (a keyword lookup, a price quote), never a write.
 */
import { routes } from "./routes.js";

export function sampleResponse(url, method = "GET", requestBody = null) {
  const path = url.pathname.replace(/\/+$/, "");
  const verb = method === "HEAD" ? "GET" : method;
  for (const entry of routes) {
    const [pattern, handler, routeMethod = "GET"] = entry;
    if (routeMethod !== verb) continue;
    const match = typeof pattern === "string" ? (pattern === path ? [] : null) : path.match(pattern);
    if (match) {
      const body = handler(url, match.slice ? match.slice(1) : [], requestBody);
      if (body === undefined) return null;
      return body && body.__status ? { status: body.__status, body: body.body } : { body };
    }
  }
  return null;
}
