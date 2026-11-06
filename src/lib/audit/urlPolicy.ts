// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/url-policy.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import dns from "node:dns/promises";
import { AppError } from "../http/appError.ts";
import { isBlockedHostName, normalizeHost } from "../http/hostPolicy.ts";
import { safeFetch as defaultSafeFetch } from "../http/safeFetch.ts";

async function defaultLookup(hostname: string): Promise<string[]> {
  try {
    const res = await dns.lookup(hostname, { all: true });
    return res.map((r) => r.address);
  } catch {
    return [];
  }
}

export function isOwnedHost(candidateHost: string, baseHost: string): boolean {
  const clean = (h: string): string => {
    let host = h.toLowerCase().trim();
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    if (host.endsWith(".")) {
      host = host.slice(0, -1);
    }
    const colon = host.lastIndexOf(":");
    if (colon !== -1 && !host.includes("::")) {
      host = host.slice(0, colon);
    }
    return host;
  };

  const cand = clean(candidateHost);
  const base = clean(baseHost);
  if (!cand || !base) return false;
  return cand === base || cand.endsWith(`.${base}`);
}

function isPrivateIpv4(host: string): boolean {
  const parts = normalizeHost(host)
    .split(".")
    .map((x) => Number(x));
  if (
    parts.length !== 4 ||
    parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function parseMappedIpv4FromIpv6(host: string): string | null {
  const normalized = normalizeHost(host);
  if (!normalized.startsWith("::ffff:")) return null;

  const mapped = normalized.slice("::ffff:".length);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
    return mapped;
  }

  const segments = mapped.split(":").filter(Boolean);
  if (segments.length !== 2) return null;

  const high = Number.parseInt(segments[0], 16);
  const low = Number.parseInt(segments[1], 16);
  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }

  const a = (high >> 8) & 0xff;
  const b = high & 0xff;
  const c = (low >> 8) & 0xff;
  const d = low & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function isPrivateIpv6(host: string): boolean {
  const value = normalizeHost(host);
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  ) {
    return true;
  }

  const mappedIpv4 = parseMappedIpv4FromIpv6(value);
  if (mappedIpv4 && isPrivateIpv4(mappedIpv4)) {
    return true;
  }

  return false;
}

function isIpLiteral(host: string): boolean {
  const normalized = normalizeHost(host);
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalized) || normalized.includes(":");
}

export function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (isBlockedHostName(host)) return true;

  if (isIpLiteral(host)) {
    return isPrivateIpv4(host) || isPrivateIpv6(host);
  }

  return false;
}

export function isCrawlableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return !isBlockedHost(parsed.hostname);
}

export async function isShopifyHost(
  hostname: string,
  deps?: { lookup?: (host: string) => Promise<string[]> },
): Promise<boolean> {
  try {
    const lookup = deps?.lookup ?? defaultLookup;
    const addresses = await lookup(normalizeHost(hostname));
    return addresses.some((address) => address.startsWith("23.227.38."));
  } catch {
    return false;
  }
}

export async function normalizeAndValidateStartUrl(
  input: string,
  deps?: { lookup?: (host: string) => Promise<string[]> },
): Promise<string> {
  let raw = input.trim();
  if (!raw) {
    throw new AppError(422, "validation_error", "Empty start URL");
  }

  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(422, "validation_error", "Invalid start URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError(422, "validation_error", "Unsupported scheme; only http and https are allowed");
  }

  if (isBlockedHost(parsed.hostname)) {
    throw new AppError(422, "url_blocked", "Crawl target host is blocked");
  }

  const lookup = deps?.lookup ?? defaultLookup;
  try {
    const addresses = await lookup(normalizeHost(parsed.hostname));
    if (addresses.some((addr) => isPrivateIpv4(addr) || isPrivateIpv6(addr))) {
      throw new AppError(422, "url_blocked", "Hostname resolves to a private IP");
    }
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    throw new AppError(422, "url_unreachable", "DNS lookup failed for crawl target");
  }

  parsed.hash = "";
  return parsed.toString();
}

const START_URL_REDIRECT_HOPS = 5;
const START_URL_PROBE_TIMEOUT_MS = 10_000;

export async function resolveStartUrlRedirects(
  startUrl: string,
  opts?: {
    accessHeaders?: Record<string, string>;
    safeFetch?: typeof defaultSafeFetch;
    lookup?: (host: string) => Promise<string[]>;
  },
): Promise<{ url: string; poweredBy: string | null }> {
  const fetcher = opts?.safeFetch ?? defaultSafeFetch;
  let current = startUrl;

  for (let hop = 0; hop < START_URL_REDIRECT_HOPS; hop++) {
    let response: { status: number; headers: Headers; body: Uint8Array };
    try {
      response = await fetcher(
        current,
        {
          method: "HEAD",
          maxRedirects: 0,
          timeoutMs: START_URL_PROBE_TIMEOUT_MS,
          headers: opts?.accessHeaders ?? {},
        },
        opts?.lookup ? { lookup: opts.lookup } : undefined,
      );
    } catch {
      return { url: current, poweredBy: null };
    }

    if (response.status < 300 || response.status >= 400) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }

    const location = response.headers.get("location");
    if (!location) {
      return { url: current, poweredBy: response.headers.get("powered-by") };
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { url: current, poweredBy: null };
    }

    try {
      current = await normalizeAndValidateStartUrl(next.toString(), { lookup: opts?.lookup });
    } catch {
      // The redirect hopped to an invalid or blocked address (e.g. 127.0.0.1)
      return { url: current, poweredBy: null };
    }
  }

  return { url: current, poweredBy: null };
}
