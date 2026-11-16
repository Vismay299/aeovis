// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/services/shopifySignature.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { SHOPIFY_SIGNATURE_AGENT } from "./crawlerAccess.ts";
import { safeFetch } from "../http/safeFetch.ts";
import type { SafeFetchResult } from "../http/safeFetch.ts";

/**
 * Checks a Shopify crawler-access signature against the domain it will be sent
 * to, before it is saved. Shopify signs the domain picked in admin
 * (`@authority`) and the `Signature-Agent` value, so a signature minted for the
 * `www.` twin or for another store is rejected at save time rather than stored
 * and ignored by the crawl.
 */

const SHOPIFY_KEY_DIRECTORY_URL =
  "https://shopify.com/.well-known/http-message-signatures-directory";
const KEY_DIRECTORY_TIMEOUT_MS = 5_000;
const KEY_DIRECTORY_MAX_BYTES = 64 * 1024;

export type ShopifySignatureProblem =
  | { reason: "wrong_domain"; host: string; signedHost: string }
  | { reason: "invalid"; host: string };

const directoryKeySchema = z.object({ kid: z.string(), x: z.string() });

export type ShopifySignatureDeps = {
  safeFetch?: typeof safeFetch;
  directoryUrl?: string;
};

/**
 * Null means the signature is fine for `host`, or could not be checked: an
 * unreachable directory, a rotated key id or an unparseable body never blocks
 * a save.
 */
export async function checkShopifySignature(
  input: { host: string; signatureInput: string; signature: string },
  deps?: ShopifySignatureDeps,
): Promise<ShopifySignatureProblem | null> {
  const { host, signatureInput } = input;
  const params = /^\w+=(\(.+)$/.exec(signatureInput)?.[1];
  const keyId = /;keyid="([^"]+)"/.exec(signatureInput)?.[1];
  const signatureBytes = decodeSignature(input.signature);
  if (!params || !keyId || !signatureBytes) return { reason: "invalid", host };

  const key = await importShopifyKey(keyId, deps);
  if (!key) return null;

  // RFC 9421 signature base over what Shopify signs, ending with the
  // signature parameters exactly as they appear after the label.
  const verifiesFor = (domain: string) =>
    crypto.subtle.verify(
      "Ed25519",
      key,
      signatureBytes,
      new TextEncoder().encode(
        `"@authority": ${domain}\n"signature-agent": ${SHOPIFY_SIGNATURE_AGENT}\n"@signature-params": ${params}`,
      ),
    );

  if (await verifiesFor(host)) return null;
  const twinHost = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  if (await verifiesFor(twinHost)) {
    return { reason: "wrong_domain", host, signedHost: twinHost };
  }
  return { reason: "invalid", host };
}

/** The bytes of a `sig1=:<base64>:` value, or null if it is not one. */
function decodeSignature(signature: string): Uint8Array<ArrayBuffer> | null {
  const base64 = /^\w+=:([A-Za-z0-9+/]+={0,2}):$/.exec(signature)?.[1];
  if (!base64) return null;
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    // Ed25519 signatures are 64 bytes, and the runtime throws on any other
    // length instead of failing the verify.
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

async function importShopifyKey(
  keyId: string,
  deps?: ShopifySignatureDeps,
): Promise<CryptoKey | null> {
  try {
    const fetcher = deps?.safeFetch ?? safeFetch;
    const response: SafeFetchResult = await fetcher(
      deps?.directoryUrl ?? SHOPIFY_KEY_DIRECTORY_URL,
      {
        method: "GET",
        timeoutMs: KEY_DIRECTORY_TIMEOUT_MS,
        maxRedirects: 0,
        maxBytes: KEY_DIRECTORY_MAX_BYTES,
        truncate: true,
      },
    );
    if (response.status < 200 || response.status >= 300) return null;
    const { kid, x } = directoryKeySchema.parse(response.json());
    // A signature made with a key Shopify has since rotated out may still be
    // valid, so it is left unchecked rather than rejected.
    if (kid !== keyId) return null;
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x },
      "Ed25519",
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}
