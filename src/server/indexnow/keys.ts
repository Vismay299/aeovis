// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/indexnow/services/IndexNowService.ts
//   src/server/features/projects/repositories/ProjectRepository.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/errors.ts";
import { keyFileReady } from "../../shared/indexnow.ts";
import type { HostCheck } from "./keyFile.ts";

export function generateIndexNowKey(randomUUID?: () => string): string {
  const uuidGen = randomUUID ?? (() => crypto.randomUUID());
  return uuidGen().replaceAll("-", "").toLowerCase();
}

export function indexNowDomain(brand: { website_host: string }): string {
  if (!brand?.website_host || typeof brand.website_host !== "string" || !brand.website_host.trim()) {
    throw new AppError(400, "invalid_request", "This workspace has no website.");
  }
  let host = brand.website_host.trim().toLowerCase();
  if (host.startsWith("www.")) {
    host = host.slice(4);
  }
  return host;
}

export function indexNowHosts(domain: string): [string, string] {
  return [domain, `www.${domain}`];
}

export async function getSetup(
  admin: SupabaseClient,
  ws: { brandKey: string; brand: { website_host: string } }
): Promise<{ domain: string; key: string | null; hosts: HostCheck[] | null; checkedAt: string | null; ready: boolean }> {
  const domain = indexNowDomain(ws.brand);
  const { data, error } = await admin
    .from("indexnow_keys")
    .select("key, last_check, last_checked_at")
    .eq("brand_key", ws.brandKey)
    .maybeSingle();

  if (error) {
    throw new AppError(503, "indexnow_unavailable", "IndexNow could not be reached. Please retry.");
  }

  if (!data?.key) {
    return {
      domain,
      key: null,
      hosts: null,
      checkedAt: null,
      ready: false,
    };
  }

  const hosts = Array.isArray(data.last_check) ? (data.last_check as HostCheck[]) : null;
  const checkedAt = data.last_checked_at ? new Date(data.last_checked_at).toISOString() : null;
  const ready = hosts ? keyFileReady(hosts) : false;

  return {
    domain,
    key: data.key,
    hosts,
    checkedAt,
    ready,
  };
}

export async function ensureKey(
  admin: SupabaseClient,
  ws: { brandKey: string; brand: { website_host: string }; user?: { id?: string } | null },
  deps?: { generateKey?: () => string }
): Promise<{ domain: string; key: string; created: boolean }> {
  const domain = indexNowDomain(ws.brand);
  const generator = deps?.generateKey ?? generateIndexNowKey;
  const candidateKey = generator();

  const actorId = ws.user?.id ?? null;
  const { data, error } = await admin.rpc("indexnow_ensure_key", {
    p_brand: ws.brandKey,
    p_key: candidateKey,
    p_actor: actorId,
  });

  if (error) {
    throw new AppError(503, "indexnow_unavailable", "IndexNow could not be reached. Please retry.");
  }

  const rows = data as Array<{ key: string; created: boolean }> | null;
  if (!rows || rows.length === 0) {
    throw new AppError(503, "indexnow_unavailable", "IndexNow could not be reached. Please retry.");
  }

  const row = rows[0];
  return {
    domain,
    key: row.key,
    created: Boolean(row.created),
  };
}
