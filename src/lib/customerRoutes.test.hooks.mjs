// Substitute only the authenticated request context and DB transport. The real
// route handlers and NextResponse still run in the regression tests.
import { resolve as resolveRoute } from "./cronAuth.route.hooks.mjs";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/supabase/customer" || (specifier === "./customer.js" && context.parentURL?.endsWith("/customerRoute.js"))) {
    const source = `
      export async function getCustomerContext() { return globalThis.customerRouteFixture.context; }
      export function findCustomerBrand(brands, key) { return brands.find((brand) => brand.brandKey === key) || null; }
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  if (specifier === "@/lib/supabase/admin") {
    return { url: `data:text/javascript,${encodeURIComponent("export function getSupabaseAdmin() { return globalThis.customerRouteFixture.admin; }")}`, shortCircuit: true };
  }
  // The customer scan route's job insert is DB transport too; the test decides
  // whether it succeeds or hits the one-running-scan seal.
  if (specifier === "@/lib/db" && context.parentURL?.endsWith("/app/api/customer/scan/route.js")) {
    const source = `
      export async function createScanJob(args) {
        const create = globalThis.customerRouteFixture.createScanJob;
        if (!create) throw new Error("createScanJob is not stubbed for this test");
        return create(args);
      }
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return resolveRoute(specifier, context, nextResolve);
}
