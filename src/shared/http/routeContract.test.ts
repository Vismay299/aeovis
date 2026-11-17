// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/output-schema-contract.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { closedOutputPaths } from "./schemaContract.ts";
import { defineRouteContract } from "./routeContract.ts";
import type { RouteContract } from "./routeContract.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function rootIsClosed(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { additionalProperties?: unknown }).additionalProperties === false
  );
}

async function contractViolations(contract: RouteContract): Promise<string[]> {
  const problems: string[] = [];
  if (!contract.id) problems.push("contract has no id");
  if (!contract.response) {
    problems.push(`${contract.id}: response schema is missing`);
  } else {
    let outputSchema: unknown;
    try {
      outputSchema = z.toJSONSchema(contract.response, { io: "output" });
    } catch {
      problems.push(`${contract.id}: response schema is not representable as JSON Schema`);
    }
    if (outputSchema !== undefined) {
      problems.push(...closedOutputPaths(outputSchema, contract.id));
    }
  }
  const examples = Array.isArray(contract.examples) ? contract.examples : [];
  if (examples.length === 0) problems.push(`${contract.id}: at least one example is required`);
  for (const example of examples) {
    if (contract.response && !contract.response.safeParse(example?.response).success) {
      problems.push(`${contract.id}: an example does not parse with its response schema`);
    }
  }
  if (contract.request) {
    let inputSchema: unknown;
    try {
      inputSchema = z.toJSONSchema(contract.request, { io: "input" });
    } catch {
      problems.push(`${contract.id}: request schema is not a JSON object`);
    }
    if (inputSchema !== undefined && !rootIsClosed(inputSchema)) {
      problems.push(`${contract.id}: request schema must be closed (use z.strictObject)`);
    }
  }
  if (contract.query) {
    let querySchema: unknown;
    try {
      querySchema = z.toJSONSchema(contract.query, { io: "input" });
    } catch {
      problems.push(`${contract.id}: query schema is not a JSON object`);
    }
    if (querySchema !== undefined && !rootIsClosed(querySchema)) {
      problems.push(`${contract.id}: query schema must be closed (use z.strictObject)`);
    }
  }
  const filePath = path.join(REPO, contract.file ?? "");
  if (!contract.file || !existsSync(filePath)) {
    problems.push(`${contract.id}: file ${contract.file} does not exist`);
  } else {
    const mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
    if (typeof mod[contract.method] !== "function") {
      problems.push(`${contract.id}: ${contract.file} does not export ${contract.method}`);
    }
  }
  return problems;
}

test("finds constraints inside arrays, unions, and referenced definitions", () => {
  assert.deepEqual(
    closedOutputPaths(
      {
        properties: {
          rows: {
            items: { anyOf: [{ $ref: "#/$defs/row" }, { type: "null" }] },
          },
        },
        $defs: { row: { type: "object", additionalProperties: false } },
        allOf: [{ unevaluatedProperties: false }],
      },
      "tool"
    ),
    ["tool.$defs.row.additionalProperties", "tool.allOf[0].unevaluatedProperties"]
  );
});

test("finds closed objects inside array items and unions", () => {
  assert.deepEqual(
    closedOutputPaths(
      {
        properties: {
          rows: {
            items: {
              anyOf: [
                { type: "object", additionalProperties: false },
                { type: "null" },
              ],
            },
          },
        },
      },
      "tool"
    ),
    ["tool.properties.rows.items[0].anyOf[0].additionalProperties"]
  );
});

test("every discovered route contract has a closed response with examples", async () => {
  const files = globSync("src/{server,shared}/**/*.contract.ts", { cwd: REPO }).sort();
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const mod = (await import(pathToFileURL(path.join(REPO, file)).href)) as Record<string, unknown>;
    const contracts = mod.contracts;
    assert.ok(Array.isArray(contracts), `${file} must export contracts: RouteContract[]`);
    for (const contract of contracts as RouteContract[]) {
      // Each file is imported once here, so any repeated id is a real
      // duplicate, whether it comes from another file or from this one twice.
      const owner = seen.get(contract.id);
      if (owner !== undefined) {
        problems.push(`${contract.id}: id is already declared by ${owner}`);
      }
      seen.set(contract.id, file);
      problems.push(...(await contractViolations(contract)));
    }
  }
  assert.deepEqual(
    problems,
    [],
    "Use z.looseObject() for responses and z.strictObject() for requests; clients must accept added fields."
  );
});

test("the harness catches a closed response schema", async () => {
  const { fixtureContracts } = await import("./__fixtures__/closed.contract.fixture.ts");
  const problems = await contractViolations(fixtureContracts[0]);
  assert.deepEqual(problems, ["fixture.closed_response.additionalProperties"]);
});

test("the harness reports an unrepresentable response schema instead of aborting", async () => {
  const problems = await contractViolations({
    id: "fixture.unrepresentable",
    method: "GET",
    path: "/api/fixture/date",
    file: "src/shared/http/__fixtures__/closed.handler.fixture.ts",
    auth: "workspace",
    response: z.date(),
    errorCodes: [],
    examples: [{ response: new Date(0) }],
  });
  assert.deepEqual(problems, ["fixture.unrepresentable: response schema is not representable as JSON Schema"]);
});

test("defineRouteContract allows an identical re-registration but refuses a conflicting one", async () => {
  const { fixtureContracts } = await import("./__fixtures__/closed.contract.fixture.ts");
  const contract = fixtureContracts[0];
  assert.doesNotThrow(() => defineRouteContract({ ...contract }));
  assert.doesNotThrow(() => defineRouteContract({ ...contract }));
  assert.throws(
    () => defineRouteContract({ ...contract, path: "/api/fixture/other" }),
    /Duplicate route contract id: fixture\.closed_response/
  );
});
