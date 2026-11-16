// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/crawler-access.ts
//   src/server/features/audit/services/CrawlerCredentialService.ts
//   src/server/features/audit/repositories/CrawlerCredentialRepository.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { isOwnedHost } from "./urlPolicy.ts";
import {
  CRAWLER_ACCESS_FIELDS,
  CRAWLER_ACCESS_UNAVAILABLE,
  crawlerAccessAad,
  decryptCrawlerField,
  encryptCrawlerField,
  isCrawlerAccessConfigured,
} from "./crawlerAccessCrypto.ts";
import {
  checkShopifySignature,
  type ShopifySignatureProblem,
} from "./shopifySignature.ts";

/**
 * Shopify crawler access. A merchant mints a domain-scoped signature in Shopify
 * admin and the crawler replays it as three static headers on every request to
 * that exact https host. The helpers below are pure so the crawler and the
 * input validation share one binding rule.
 */

/** Constant Shopify expects, quotes included. We supply it; users never see it. */
export const SHOPIFY_SIGNATURE_AGENT = '"https://shopify.com"';

export const SHOPIFY_CRAWLER_ACCESS_DOC_URL =
  "https://help.shopify.com/en/manual/promoting-marketing/seo/crawling-your-store";

export const MAX_SIGNATURE_VALUE_LENGTH = 4096;

export const CRAWLER_CREDENTIALS_TABLE = "site_audit_crawler_credentials";

/**
 * RFC 9421 signature fields are visible ASCII. Anything else (a control byte,
 * a pasted newline in the middle) would make the HTTP client reject the header,
 * and undici's error text quotes the rejected value, so it is refused at save.
 */
const HEADER_SAFE_VALUE = /^[\x20-\x7E]+$/;

export function isHeaderSafeValue(value: string): boolean {
  return HEADER_SAFE_VALUE.test(value);
}

/**
 * Before migration 128 is applied the table does not exist: Postgres reports
 * 42P01 and PostgREST PGRST205. Audits must keep starting unsigned then.
 */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

/**
 * Credential headers bound to the host they were issued for. The binding is the
 * security boundary: these values are bot-protection credentials and must never
 * be sent to another site, including across a redirect hop.
 */
export interface CrawlerAccess {
  host: string;
  headers: Record<string, string>;
  /** Checked on every request: a long crawl can outlive the signature. */
  expiresAt: string | null;
}

export function shopifyCrawlerHeaders(
  signatureInput: string,
  signature: string,
): Record<string, string> {
  return {
    "Signature-Input": signatureInput,
    Signature: signature,
    "Signature-Agent": SHOPIFY_SIGNATURE_AGENT,
  };
}

/**
 * Normalize user input into a bare lowercase hostname. Accepts a full URL
 * (people paste one) as well as a bare host. Null = not a usable hostname.
 */
export function normalizeCrawlerHost(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  // Other schemes parse hosts differently ("h://5.6" keeps "5.6", which https
  // reads as 5.0.0.6), so the saved host would never match a request.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

/**
 * Headers to send with a request to `url`, or `{}` when it is not the host the
 * signature was created for, over https, before its expiry. The host match is
 * exact: Shopify scopes a signature to one domain, so `www.store.com` and
 * `store.com` need their own. A redirect to plain http must not replay the
 * signature in cleartext.
 */
export function crawlerHeadersFor(
  url: string,
  access: CrawlerAccess | null | undefined,
  now = Date.now(),
): Record<string, string> {
  if (!access || isCrawlerAccessExpired(access.expiresAt, now)) return {};

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }

  return parsed.protocol === "https:" &&
    parsed.hostname.toLowerCase() === access.host
    ? access.headers
    : {};
}

/**
 * Shopify's `Signature-Input` is an RFC 9421 signature parameter list that may
 * carry `;expires=<unix seconds>`. Nothing beyond that parameter is assumed.
 */
export function parseSignatureExpiry(signatureInput: string): string | null {
  const match = signatureInput.match(/expires=(\d+)/);
  if (!match) return null;

  const expiresAt = new Date(Number(match[1]) * 1000);
  return Number.isNaN(expiresAt.getTime()) ? null : expiresAt.toISOString();
}

/** Shopify rejects a signature past its `expires`, so it is never replayed. */
export function isCrawlerAccessExpired(
  expiresAt: string | null,
  now = Date.now(),
): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now;
}

/** A credential as it exists at rest: ciphertext until opened inside a crawl. */
export interface SealedCrawlerAccess {
  brandKey: string;
  host: string;
  signatureInput: string;
  signature: string;
  expiresAt: string | null;
}

/** What the client is allowed to see. Signature values never leave the server. */
export interface CrawlerCredentialSummary {
  id: string;
  host: string;
  provider: "shopify";
  createdAt: string;
  expiresAt: string | null;
}

export type CrawlerAccessProblem =
  | ShopifySignatureProblem
  | { reason: "invalid_host"; host: string }
  | { reason: "audit_host_not_owned"; host: string; workspaceHost: string };

type CredentialRow = {
  id: string;
  brand_key: string;
  host: string;
  provider: string;
  encrypted_signature_input: string;
  encrypted_signature: string;
  key_version: number;
  expires_at: string | null;
  created_at: string;
};

const SUMMARY_COLUMNS = "id,host,provider,created_at,expires_at";
const SEALED_COLUMNS =
  "id,host,encrypted_signature_input,encrypted_signature,expires_at";

export interface CrawlerAccessDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  safeFetch?: unknown;
  checkShopifySignature?: typeof checkShopifySignature;
  isCrawlerAccessConfigured?: typeof isCrawlerAccessConfigured;
  encryptCrawlerField?: typeof encryptCrawlerField;
  decryptCrawlerField?: typeof decryptCrawlerField;
  warn?: (message: string) => void;
}

function isConfigured(deps?: CrawlerAccessDeps): boolean {
  return (deps?.isCrawlerAccessConfigured ?? isCrawlerAccessConfigured)(deps?.env);
}

function requireConfigured(deps?: CrawlerAccessDeps): void {
  if (!isConfigured(deps)) {
    throw new AppError(503, "crawler_access_unavailable", CRAWLER_ACCESS_UNAVAILABLE);
  }
}

function toSummary(row: CredentialRow): CrawlerCredentialSummary {
  return {
    id: row.id,
    host: row.host,
    provider: "shopify",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function allowAnyHost(env?: Record<string, string | undefined>): boolean {
  return String((env ?? process.env).SITE_AUDIT_ALLOW_ANY_HOST ?? "").toLowerCase() === "on";
}

function stripWww(host: string): string {
  return host.replace(/^www\./i, "");
}

function ownedByWorkspace(host: string, workspaceHost: string): boolean {
  return isOwnedHost(stripWww(host), stripWww(workspaceHost));
}

/**
 * The summaries for one workspace, ordered by host. Only the columns the card
 * needs: the encrypted values never leave the table.
 */
export async function listCrawlerCredentials(
  admin: any,
  brandKey: string,
  deps?: CrawlerAccessDeps,
): Promise<CrawlerCredentialSummary[]> {
  requireConfigured(deps);
  const { data, error } = await admin
    .from(CRAWLER_CREDENTIALS_TABLE)
    .select(SUMMARY_COLUMNS)
    .eq("brand_key", brandKey)
    .order("host", { ascending: true });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((row: CredentialRow) => toSummary(row));
}

/**
 * Verifies a signature for the host, encrypts both values and upserts them on
 * `(brand_key, host)`. A problem is returned for the form; only a missing key,
 * a broken database or an unexpected error throws.
 */
export async function saveCrawlerCredential(
  admin: any,
  input: {
    brandKey: string;
    userId: string;
    host: string;
    signatureInput: string;
    signature: string;
    workspaceHost?: string;
  },
  deps?: CrawlerAccessDeps,
): Promise<{ credential: CrawlerCredentialSummary } | { problem: CrawlerAccessProblem }> {
  requireConfigured(deps);

  const host = normalizeCrawlerHost(input.host);
  if (!host) return { problem: { reason: "invalid_host", host: input.host } };

  const workspaceHost = input.workspaceHost ? normalizeCrawlerHost(input.workspaceHost) : null;
  if (
    !allowAnyHost(deps?.env) &&
    (!workspaceHost || !ownedByWorkspace(host, workspaceHost))
  ) {
    return {
      problem: {
        reason: "audit_host_not_owned",
        host,
        workspaceHost: workspaceHost ?? (input.workspaceHost ?? ""),
      },
    };
  }

  // Copy-paste from Shopify admin often carries surrounding whitespace.
  const signatureInput = input.signatureInput.trim();
  const signature = input.signature.trim();
  if (!isHeaderSafeValue(signatureInput) || !isHeaderSafeValue(signature)) {
    return { problem: { reason: "invalid", host } };
  }

  const check = deps?.checkShopifySignature ?? checkShopifySignature;
  const problem = await check(
    { host, signatureInput, signature },
    { safeFetch: deps?.safeFetch as any },
  );
  if (problem) return { problem };

  const encrypt = deps?.encryptCrawlerField ?? encryptCrawlerField;
  const encryptedSignatureInput = encrypt(
    signatureInput,
    crawlerAccessAad(input.brandKey, host, CRAWLER_ACCESS_FIELDS[0]),
    deps?.env,
  );
  const encryptedSignature = encrypt(
    signature,
    crawlerAccessAad(input.brandKey, host, CRAWLER_ACCESS_FIELDS[1]),
    deps?.env,
  );

  // No `id` in the payload: the DB default supplies one on insert, and
  // PostgREST's ON CONFLICT DO UPDATE must not rewrite the existing primary key
  // (a re-save would break site_audits_crawler_credential_fk).
  const { error } = await admin.from(CRAWLER_CREDENTIALS_TABLE).upsert(
    {
      brand_key: input.brandKey,
      host,
      provider: "shopify",
      encrypted_signature_input: encryptedSignatureInput,
      encrypted_signature: encryptedSignature,
      key_version: 1,
      expires_at: parseSignatureExpiry(signatureInput),
      created_by: input.userId,
    },
    { onConflict: "brand_key,host" },
  );
  if (error) throw error;

  const saved = await admin
    .from(CRAWLER_CREDENTIALS_TABLE)
    .select(SUMMARY_COLUMNS)
    .eq("brand_key", input.brandKey)
    .eq("host", host)
    .maybeSingle();
  if (saved.error) throw saved.error;
  if (!saved.data) throw new Error("Crawler credential was not stored.");
  return { credential: toSummary(saved.data as CredentialRow) };
}

/** Scoped by workspace: a foreign id deletes nothing and reports false. */
export async function deleteCrawlerCredential(
  admin: any,
  brandKey: string,
  id: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from(CRAWLER_CREDENTIALS_TABLE)
    .delete()
    .eq("brand_key", brandKey)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/**
 * The unexpired credential the crawler should replay for this host, if any.
 * An expired one is skipped: Shopify rejects it, and the report names the
 * expiry.
 */
export async function resolveCrawlerAccess(
  admin: any,
  brandKey: string,
  host: string,
  deps?: CrawlerAccessDeps,
): Promise<{ id: string; sealed: SealedCrawlerAccess } | null> {
  const { data, error } = await admin
    .from(CRAWLER_CREDENTIALS_TABLE)
    .select(SEALED_COLUMNS)
    .eq("brand_key", brandKey)
    .eq("host", host)
    .maybeSingle();
  if (error) {
    if (MISSING_TABLE_CODES.has(String(error.code ?? ""))) return null;
    throw error;
  }
  if (!data) return null;
  const row = data as CredentialRow;
  if (isCrawlerAccessExpired(row.expires_at, deps?.now?.() ?? Date.now())) return null;

  return {
    id: row.id,
    sealed: {
      brandKey,
      host: row.host,
      signatureInput: row.encrypted_signature_input,
      signature: row.encrypted_signature,
      expiresAt: row.expires_at,
    },
  };
}

/**
 * Decrypts in memory only. The result must never be persisted or logged.
 * A missing key throws (fail closed); a rotated or corrupt value logs one line
 * naming only the host and lets the crawl continue unsigned.
 */
export async function openCrawlerAccess(
  sealed: SealedCrawlerAccess | null | undefined,
  deps?: CrawlerAccessDeps,
): Promise<CrawlerAccess | null> {
  if (!sealed) return null;
  requireConfigured(deps);

  const decrypt = deps?.decryptCrawlerField ?? decryptCrawlerField;
  try {
    const signatureInput = decrypt(
      sealed.signatureInput,
      crawlerAccessAad(sealed.brandKey, sealed.host, CRAWLER_ACCESS_FIELDS[0]),
      deps?.env,
    );
    const signature = decrypt(
      sealed.signature,
      crawlerAccessAad(sealed.brandKey, sealed.host, CRAWLER_ACCESS_FIELDS[1]),
      deps?.env,
    );
    if (!isHeaderSafeValue(signatureInput) || !isHeaderSafeValue(signature)) {
      throw new Error("Crawler access value is not header-safe.");
    }
    return {
      host: sealed.host,
      expiresAt: sealed.expiresAt,
      headers: shopifyCrawlerHeaders(signatureInput, signature),
    };
  } catch {
    const warn = deps?.warn ?? ((message: string) => console.warn(message));
    warn(`[audit] crawler access unreadable host=${sealed.host}`);
    return null;
  }
}
