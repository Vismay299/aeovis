// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/output-schema-contract.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

function closedOutputPathsIn(schema: unknown, path: string, failures: string[]): void {
  if (typeof schema !== "object" || schema === null) return;
  const entries: [string, unknown][] = Object.entries(schema);
  for (const [key, value] of entries) {
    if ((key === "additionalProperties" || key === "unevaluatedProperties") && value === false) {
      failures.push(`${path}.${key}`);
    }
    if (
      ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) &&
      typeof value === "object" &&
      value !== null
    ) {
      for (const [name, child] of Object.entries(value)) {
        closedOutputPathsIn(child, `${path}.${key}.${name}`, failures);
      }
    } else if (
      [
        "items",
        "prefixItems",
        "anyOf",
        "oneOf",
        "allOf",
        "contains",
        "additionalProperties",
        "unevaluatedProperties",
        "not",
        "if",
        "then",
        "else",
        "propertyNames",
      ].includes(key)
    ) {
      const children = Array.isArray(value) ? value : [value];
      children.forEach((child, index) => {
        closedOutputPathsIn(child, `${path}.${key}[${index}]`, failures);
      });
    }
  }
}

export function closedOutputPaths(schema: unknown, path: string): string[] {
  const failures: string[] = [];
  closedOutputPathsIn(schema, path, failures);
  return failures;
}
