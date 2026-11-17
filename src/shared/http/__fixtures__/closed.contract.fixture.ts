import { z } from "zod";
import { defineRouteContract } from "../routeContract.ts";

export const fixtureContracts = [
  defineRouteContract({
    id: "fixture.closed_response",
    method: "GET",
    path: "/api/fixture/closed",
    file: "src/shared/http/__fixtures__/closed.handler.fixture.ts",
    auth: "workspace",
    response: z.object({ ok: z.boolean() }),
    errorCodes: [],
    examples: [{ response: { ok: true } }],
  }),
];
