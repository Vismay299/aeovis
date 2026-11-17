import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // probe next
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return nextResolve("next/server.js", context);
  }
  if (
    specifier === "@/shared/supabase/customer" ||
    specifier.endsWith("/supabase/customer.js") ||
    specifier.endsWith("/supabase/customer")
  ) {
    const source = `
      export async function createCustomerSupabaseClient() {
        return globalThis.callbackRouteFixture?.createClient ? globalThis.callbackRouteFixture.createClient() : null;
      }
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  if (
    specifier === "@/shared/supabase/admin" ||
    specifier.endsWith("/supabase/admin.js") ||
    specifier.endsWith("/supabase/admin")
  ) {
    const source = `
      export function getSupabaseAdmin() {
        return globalThis.callbackRouteFixture?.getAdminClient ? globalThis.callbackRouteFixture.getAdminClient() : null;
      }
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const base = path.join(SRC_DIR, specifier.slice(2));
    const hit = firstExistingFile([
      base,
      `${base}.ts`,
      `${base}.js`,
      `${base}.mjs`,
      path.join(base, "index.ts"),
      path.join(base, "index.js"),
    ]);
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
