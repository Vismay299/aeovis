// Structured data inspector for Perceev site audit.
// Validates JSON-LD blocks against syntax, Schema.org types, required Google properties,
// and visible page claims.

import { STRUCTURED_DATA_REQUIRED } from "../../shared/structured-data-rules.ts";
import type { StructuredDataInspection } from "./types.ts";

function cleanType(rawType: string): string {
  return rawType
    .replace(/^https?:\/\/schema\.org\//i, "")
    .replace(/^schema\.org\//i, "")
    .trim();
}

function extractTypes(raw: unknown): string[] {
  if (typeof raw === "string") {
    return [cleanType(raw)];
  }
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string").map(cleanType);
  }
  return [];
}

function isValuePresent(val: unknown): boolean {
  if (val === undefined || val === null) return false;
  if (typeof val === "string" && val.trim() === "") return false;
  if (Array.isArray(val) && val.length === 0) return false;
  return true;
}

export function inspectJsonLd(
  blocks: string[],
  visibleText: string,
): StructuredDataInspection {
  const inspectionBlocks: Array<{ parseState: "valid" | "invalid"; types: string[] }> = [];
  let missingType = 0;
  const missingRequired: Array<{ type: string; missing: string[] }> = [];
  const claimsNotVisible: Array<{ path: string; value: string }> = [];

  const lowerText = visibleText.toLowerCase();

  for (const block of blocks) {
    if (block.endsWith("/*CUT*/")) {
      inspectionBlocks.push({ parseState: "invalid", types: [] });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      inspectionBlocks.push({ parseState: "invalid", types: [] });
      continue;
    }

    const blockTypes = new Set<string>();
    let objectCount = 0;

    const inspectObject = (obj: Record<string, unknown>, path: string, isTopLevel: boolean, depth: number) => {
      if (depth > 6 || objectCount >= 200) return;
      objectCount += 1;

      const types = extractTypes(obj["@type"]);
      if (types.length === 0) {
        // If it's a @graph container, it is not an entity itself
        if (isTopLevel && !("@graph" in obj)) {
          missingType += 1;
        }
      } else {
        for (const t of types) {
          blockTypes.add(t);
          const req = STRUCTURED_DATA_REQUIRED[t];
          if (req) {
            const missingProps: string[] = [];
            for (const propOrGroup of req) {
              if (Array.isArray(propOrGroup)) {
                const anyPresent = propOrGroup.some((p) => isValuePresent(obj[p]));
                if (!anyPresent) {
                  missingProps.push(propOrGroup.join("|"));
                }
              } else {
                if (!isValuePresent(obj[propOrGroup])) {
                  missingProps.push(propOrGroup);
                }
              }
            }
            if (missingProps.length > 0 && missingRequired.length < 10) {
              missingRequired.push({ type: t, missing: missingProps });
            }
          }
        }
      }

      // Check claims
      for (const [k, val] of Object.entries(obj)) {
        if (
          ["name", "description", "price", "ratingValue", "sku"].includes(k) &&
          (typeof val === "string" || typeof val === "number")
        ) {
          const strVal = String(val).trim();
          if (strVal.length >= 3 && claimsNotVisible.length < 20) {
            if (!lowerText.includes(strVal.toLowerCase())) {
              claimsNotVisible.push({
                path: `${path}.${k}`,
                value: strVal.slice(0, 100),
              });
            }
          }
        } else if (val && typeof val === "object" && !Array.isArray(val)) {
          inspectObject(val as Record<string, unknown>, `${path}.${k}`, false, depth + 1);
        } else if (Array.isArray(val)) {
          for (let i = 0; i < val.length; i++) {
            const item = val[i];
            if (item && typeof item === "object") {
              const isGraph = k === "@graph";
              inspectObject(item as Record<string, unknown>, `${path}.${k}[${i}]`, isGraph, depth + 1);
            }
          }
        }
      }
    };

    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed)) {
        for (let i = 0; i < parsed.length; i++) {
          const item = parsed[i];
          if (item && typeof item === "object") {
            inspectObject(item as Record<string, unknown>, `$[${i}]`, true, 1);
          }
        }
      } else {
        inspectObject(parsed as Record<string, unknown>, "$", true, 1);
      }
    }

    inspectionBlocks.push({
      parseState: "valid",
      types: Array.from(blockTypes),
    });
  }

  return {
    blocks: inspectionBlocks,
    missingType,
    missingRequired,
    claimsNotVisible,
  };
}
