import { NextResponse } from "next/server";
import { getCustomerContext, findCustomerBrand } from "./customer.js";

export async function customerRouteContext(request, explicitKey) {
  const context = await getCustomerContext();
  const fail = (status, error) => ({ response: NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } }) });
  if (context.error === "auth_not_configured") return fail(503, "Customer login is not configured.");
  if (!context.user) return fail(401, "Please sign in.");
  if (context.error) return fail(503, "Could not load workspace access.");
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return fail(403, "Cross-site requests are not allowed.");
  }
  const key = explicitKey || new URL(request.url).searchParams.get("brand_key") || context.brands[0]?.brandKey;
  const brand = findCustomerBrand(context.brands, key);
  if (!brand) return fail(404, "Workspace not found.");
  return { ...context, brand };
}
