import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const redirectsFixtures: Fixture[] = [
  {
    path: "/redirects/chain-start",
    name: "Redirect chain start",
    category: "redirects",
    expectedIssues: ["redirect-chain"],
    handler: () =>
      new Response(null, {
        status: 301,
        headers: { location: "/redirects/chain-mid" },
      }),
  },
  {
    path: "/redirects/chain-mid",
    name: "Redirect chain intermediate",
    category: "redirects",
    support: true,
    expectedIssues: [],
    handler: () =>
      new Response(null, {
        status: 301,
        headers: { location: "/redirects/chain-end" },
      }),
  },
  {
    path: "/redirects/chain-end",
    name: "Redirect chain destination",
    category: "redirects",
    support: true,
    expectedIssues: [],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Redirect Chain Final Destination",
          metaDescription: "The final landing page following the multiple redirect hops successfully.",
          bodyHtml: `<h1>Final Destination</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/redirects/loop-a",
    name: "Redirect loop node A",
    category: "redirects",
    expectedIssues: ["redirect-loop"],
    handler: () =>
      new Response(null, {
        status: 301,
        headers: { location: "/redirects/loop-b" },
      }),
  },
  {
    path: "/redirects/loop-b",
    name: "Redirect loop node B",
    category: "redirects",
    support: true,
    expectedIssues: [],
    handler: () =>
      new Response(null, {
        status: 301,
        headers: { location: "/redirects/loop-a" },
      }),
  },
];
