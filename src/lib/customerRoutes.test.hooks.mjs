// Substitute only the authenticated request context and DB transport. The real
// route handlers and NextResponse still run in the regression tests.
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolveRoute } from "./cronAuth.route.hooks.mjs";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  if (specifier === "next/headers") {
    return nextResolve("next/headers.js", context);
  }
  if (
    specifier === "@/lib/supabase/customer" ||
    specifier.endsWith("/supabase/customer.js") ||
    specifier.endsWith("/supabase/customer") ||
    (specifier === "./customer.js" && context.parentURL?.endsWith("/customerRoute.js"))
  ) {
    const source = `
      export async function getCustomerContext() { return globalThis.customerRouteFixture.context; }
      export function findCustomerBrand(brands, key) { return brands.find((brand) => brand.brandKey === key) || null; }
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  if (specifier === "@/lib/supabase/admin" || specifier.endsWith("/supabase/admin.js")) {
    const source = `
      export function getSupabaseAdmin() { return globalThis.customerRouteFixture?.admin || null; }
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  // The customer scan route's job insert is DB transport too; the test decides
  // whether it succeeds or hits the one-running-scan seal.
  if (
    (specifier === "@/lib/db" || specifier.endsWith("/db.js")) &&
    (context.parentURL?.includes("/app/api/customer/scan/route.") ||
      context.parentURL?.includes("/pricing/startCustomerScan."))
  ) {
    const source = `
      export async function createScanJob(args) {
        const create = globalThis.customerRouteFixture?.createScanJob;
        if (!create) throw new Error("createScanJob is not stubbed for this test");
        return create(args);
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
  return resolveRoute(specifier, context, nextResolve);
}
