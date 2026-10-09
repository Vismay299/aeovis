import { NextResponse } from "next/server";
import { candidateSiteUrls, getGscServiceAccount, listGscSites } from "@/lib/engines/gsc";
import { getGscConnection, upsertGscConnection } from "@/lib/db/gsc";

export const dynamic = "force-dynamic";

/**
 * R4.1.1 — connect a brand to its Google Search Console property.
 * Operator-only: not public and not SELF_GATED, so src/middleware.js requires
 * OPERATOR_TOKEN. Connect flow: docs/vendors/gsc.md.
 *
 * GET  -> { brand, connected, connection, service_account_email }
 * POST { site?: string } -> resolves `site` (default: the brand key, which is
 *      already a domain) to a property the service account can read, and saves
 *      the connection. 422 when no candidate property is accessible, naming the
 *      email the property owner must add.
 */

function brandFrom(params) {
  try {
    const b = decodeURIComponent(params?.brand || "").trim().toLowerCase();
    return b || null;
  } catch {
    return null;
  }
}

export async function GET(_request, { params }, deps = {}) {
  params = await params;
  const brand = brandFrom(params);
  if (!brand) return NextResponse.json({ error: "Brand is required." }, { status: 400 });
  try {
    const connection = await (deps.getGscConnection ?? getGscConnection)(brand, deps);
    const account = (deps.getGscServiceAccount ?? getGscServiceAccount)();
    return NextResponse.json({
      brand,
      connected: !!connection?.enabled,
      connection,
      service_account_email: account?.client_email ?? null,
    });
  } catch (error) {
    console.error(`[gsc] status read failed for "${brand}":`, error);
    return NextResponse.json({ error: "Could not read the GSC connection." }, { status: 500 });
  }
}

/**
 * Pick the first candidate for `input` that the service account can read.
 * Exported for tests. Returns { siteUrl } or { siteUrl: null, tried, accessible }.
 */
export function resolveAccessibleProperty(input, accessibleSites) {
  const tried = input && String(input).startsWith("sc-domain:") ? [String(input)] : candidateSiteUrls(input);
  const readable = new Set((accessibleSites || [])
    .filter((s) => s.permissionLevel && s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => s.siteUrl));
  // An exact property URL passed by the operator (e.g. "https://x.com/blog/") wins.
  if (input && readable.has(String(input))) return { siteUrl: String(input), tried: [String(input)] };
  const siteUrl = tried.find((c) => readable.has(c)) || null;
  return { siteUrl, tried, accessible: [...readable] };
}

export async function POST(request, { params }, deps = {}) {
  params = await params;
  const brand = brandFrom(params);
  if (!brand) return NextResponse.json({ error: "Brand is required." }, { status: 400 });

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const input = typeof body?.site === "string" && body.site.trim() ? body.site.trim() : brand;

  const account = (deps.getGscServiceAccount ?? getGscServiceAccount)();
  if (!account) {
    return NextResponse.json(
      { error: "GSC is not configured on this deployment (GSC_SERVICE_ACCOUNT_KEY is unset or invalid)." },
      { status: 503 }
    );
  }

  let sites;
  try {
    sites = await (deps.listGscSites ?? listGscSites)();
  } catch (error) {
    console.error("[gsc] could not list properties:", error);
    return NextResponse.json({ error: "Could not reach Search Console to list properties." }, { status: 502 });
  }

  const { siteUrl, tried, accessible } = resolveAccessibleProperty(input, sites);
  if (!siteUrl) {
    return NextResponse.json(
      {
        error: `No Search Console property for "${input}" is readable by the service account.`,
        action: `In Search Console, open the property -> Settings -> Users and permissions, and add ${account.client_email} as a Restricted user. Then retry.`,
        service_account_email: account.client_email,
        tried,
        accessible,
      },
      { status: 422 }
    );
  }

  try {
    const connection = await (deps.upsertGscConnection ?? upsertGscConnection)({ brand, siteUrl }, deps);
    return NextResponse.json({ brand, connected: true, connection });
  } catch (error) {
    console.error(`[gsc] connection save failed for "${brand}":`, error);
    return NextResponse.json({ error: "Could not save the GSC connection." }, { status: 500 });
  }
}
