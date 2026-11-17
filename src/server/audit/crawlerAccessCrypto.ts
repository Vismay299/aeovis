// AES-256-GCM for Shopify crawler-access signatures (F18 section 6.2.13).
// Pattern: src/server/gsc/oauthCrypto.js. A separate key because the audit worker
// replays these values against untrusted sites and must not hold other secrets.

import crypto from "node:crypto";
import { AppError } from "../../shared/http/appError.ts";

const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const CURRENT_KEY_VERSION = 1;

export const CRAWLER_ACCESS_FIELDS = ["signature_input", "signature"] as const;
export type CrawlerAccessField = (typeof CRAWLER_ACCESS_FIELDS)[number];

export const CRAWLER_ACCESS_UNAVAILABLE =
  "Shopify crawler access is unavailable right now. Please retry.";

export type CrawlerFieldEnvelope = {
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: number;
};

function encryptionKey(env?: Record<string, string | undefined>): Buffer | null {
  const hex = ((env ?? process.env).CRAWLER_ACCESS_ENCRYPTION_KEY ?? "").trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  try {
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

/** A missing or malformed key means the feature is not configured, never a silent no-op. */
export function isCrawlerAccessConfigured(env?: Record<string, string | undefined>): boolean {
  return encryptionKey(env) !== null;
}

/** `crawler:<brandKey>:<host>:<field>` binds a ciphertext to one workspace host and column. */
export function crawlerAccessAad(
  brandKey: string,
  host: string,
  field: CrawlerAccessField,
): string {
  return `crawler:${brandKey}:${host}:${field}`;
}

export function encryptCrawlerField(
  plaintext: string,
  aad: string,
  env?: Record<string, string | undefined>,
): string {
  const key = encryptionKey(env);
  if (!key) throw new AppError(503, "crawler_access_unavailable", CRAWLER_ACCESS_UNAVAILABLE);

  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));

  let encrypted = cipher.update(String(plaintext), "utf8", "base64");
  encrypted += cipher.final("base64");
  const tag = cipher.getAuthTag();

  const envelope: CrawlerFieldEnvelope = {
    ciphertext: encrypted,
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
  return JSON.stringify(envelope);
}

export function decryptCrawlerField(
  envelope: string,
  aad: string,
  env?: Record<string, string | undefined>,
): string {
  const key = encryptionKey(env);
  if (!key) throw new AppError(503, "crawler_access_unavailable", CRAWLER_ACCESS_UNAVAILABLE);

  const parsed = JSON.parse(envelope) as Partial<CrawlerFieldEnvelope>;
  if (
    typeof parsed.ciphertext !== "string" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.tag !== "string"
  ) {
    throw new Error("Crawler access envelope is malformed.");
  }

  const nonce = Buffer.from(parsed.nonce, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));

  let decrypted = decipher.update(parsed.ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
