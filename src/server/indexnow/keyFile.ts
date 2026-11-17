// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/indexnow/services/IndexNowService.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeFetch } from "../../shared/http/safeFetch.ts";
import { AppError } from "../../shared/http/errors.ts";
import { SsrfBlockedError } from "../ssrfGuard.js";
import type { KeyFileStatus } from "../../shared/indexnow.ts";
import { indexNowDomain, indexNowHosts } from "./keys.ts";
import { assertCheckAllowed, type IndexNowLimits } from "./limits.ts";

export type HostCheck = { host: string; status: KeyFileStatus };

export const KEY_FILE_MAX_BYTES = 4096;
export const KEY_CHECK_TIMEOUT_MS = 10_000;
export const KEY_CHECK_CACHE_SECONDS = 60;
export const INDEXNOW_USER_AGENT = "PerceevIndexNow/1.0 (+https://perceev.xyz)";

export async function checkKeyFile(
  host: string,
  key: string,
  deps?: { safeFetch?: typeof safeFetch }
): Promise<KeyFileStatus> {
  const fetcher = deps?.safeFetch ?? safeFetch;
  const url = `https://${host}/${key}.txt`;

  try {
    const res = await fetcher(url, {
      method: "GET",
      headers: {
        "user-agent": INDEXNOW_USER_AGENT,
        accept: "text/plain",
      },
      maxRedirects: 0,
      maxBytes: KEY_FILE_MAX_BYTES,
      timeoutMs: KEY_CHECK_TIMEOUT_MS,
    });

    if (res.status >= 200 && res.status < 300) {
      return res.text().trim() === key ? "found" : "wrong_content";
    }

    if (res.status === 404 || res.status === 410) {
      return "missing";
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        try {
          const target = new URL(location, url);
          if (target.hostname !== host && target.pathname === `/${key}.txt`) {
            return "moved";
          }
        } catch {
          // ignore URL parse errors
        }
      }
      return "redirects";
    }

    // Any other status (401, 403, 429, 5xx …)
    return "unknown";
  } catch (err: unknown) {
    if (err instanceof AppError) {
      if (err.code === "response_too_large") {
        return "wrong_content";
      }
      if (err.code === "url_unreachable") {
        return "unreachable";
      }
      if (err.code === "url_blocked" || err.code === "blocked_host") {
        return "unreachable";
      }
    }
    if (err instanceof SsrfBlockedError) {
      return "unreachable";
    }
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      return "unknown";
    }
    return "unreachable";
  }
}

export function keyFileProblem(host: string, status: KeyFileStatus): string | null {
  switch (status) {
    case "missing":
      return `No key file at the root of https://${host}. Upload it there, then try again.`;
    case "wrong_content":
      return `The key file on https://${host} should contain only the key.`;
    case "redirects":
    case "moved":
      return `The key file on https://${host} redirects. Upload it to https://${host} itself.`;
    default:
      return null;
  }
}

export async function checkKeyFiles(
  admin: SupabaseClient,
  ws: { brandKey: string; brand: { website_host: string } },
  i: { force: boolean },
  deps?: { safeFetch?: typeof safeFetch; limits?: IndexNowLimits; now?: Date }
): Promise<{ hosts: HostCheck[]; checkedAt: string; cached: boolean }> {
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
    throw new AppError(409, "indexnow_not_set_up", "Set up IndexNow first.");
  }

  const now = deps?.now ?? new Date();
  const lastChecked = data.last_checked_at ? new Date(data.last_checked_at) : null;
  const isRecent =
    lastChecked && now.getTime() - lastChecked.getTime() < KEY_CHECK_CACHE_SECONDS * 1000;

  if (!i.force && isRecent && Array.isArray(data.last_check)) {
    return {
      hosts: data.last_check as HostCheck[],
      checkedAt: lastChecked.toISOString(),
      cached: true,
    };
  }

  const hostList = indexNowHosts(domain);
  await assertCheckAllowed(admin, ws.brandKey, hostList.length, now, deps?.limits);

  const key = data.key;
  const hosts: HostCheck[] = await Promise.all(
    hostList.map(async (host) => ({
      host,
      status: await checkKeyFile(host, key, deps),
    }))
  );

  const checkRows = hosts.map((h) => ({
    brand_key: ws.brandKey,
    host: h.host,
    status: h.status,
    checked_at: now.toISOString(),
  }));

  const insertRes = await admin.from("indexnow_key_checks").insert(checkRows);
  if (insertRes.error) {
    throw new AppError(503, "indexnow_unavailable", "IndexNow could not be reached. Please retry.");
  }

  const updateRes = await admin
    .from("indexnow_keys")
    .update({
      last_check: hosts,
      last_checked_at: now.toISOString(),
    })
    .eq("brand_key", ws.brandKey);

  if (updateRes.error) {
    throw new AppError(503, "indexnow_unavailable", "IndexNow could not be reached. Please retry.");
  }

  const foundCount = hosts.filter((h) => h.status === "found").length;
  console.log(`[indexnow] check brand=${ws.brandKey} hosts=${hosts.length} found=${foundCount}`);

  return {
    hosts,
    checkedAt: now.toISOString(),
    cached: false,
  };
}
