import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument } from "./helpers.ts";

export const httpStatusFixtures: Fixture[] = [
  {
    path: "/status/500",
    name: "Internal Server Error",
    category: "http-status",
    linkedFromCatalog: false,
    expectedIssues: ["server-error"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "500 Internal Server Error",
          metaDescription: "Server encountered an error while attempting to process this request.",
          bodyHtml: "<h1>500 Internal Server Error</h1>",
        }),
        500,
      ),
  },
  {
    path: "/status/404",
    name: "Page Not Found",
    category: "http-status",
    linkedFromCatalog: false,
    expectedIssues: ["broken-page"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "404 Page Not Found",
          metaDescription: "The page you are looking for could not be located on the server.",
          bodyHtml: "<h1>404 Page Not Found</h1>",
        }),
        404,
      ),
  },
  {
    path: "/status/403",
    name: "Forbidden / Blocked Page",
    category: "http-status",
    expectedIssues: ["blocked-page"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "403 Forbidden Access",
          metaDescription: "Access to this resource has been denied by the firewall security layer.",
          bodyHtml: "<h1>403 Forbidden</h1>",
        }),
        403,
      ),
  },
  {
    path: "/status/429",
    site: "throttled",
    name: "Rate limited page (429)",
    category: "http-status",
    expectedIssues: ["rate-limited-page"],
    handler: () =>
      new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "7200" },
      }),
  },
];
